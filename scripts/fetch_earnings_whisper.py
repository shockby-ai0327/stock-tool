#!/usr/bin/env python3
"""
fetch_earnings_whisper.py — Earnings Whisper（市場真實預期 vs 官方 consensus）

Whisper number 學術背景：
  Doyle, J. T., & Lundholm, R. (2003). "Whispers and Shouts" — 公布 whisper
  EPS 比官方 analyst consensus 更準確預測股價反應。Post-earnings drift 跟
  whisper deviation 高度相關。

舉例：
  - Official consensus EPS: $1.50
  - Whisper number:         $1.65
  - 公司公布 $1.55 → 表面 beat consensus，但 miss whisper → 股價跌
  - 公司公布 $1.70 → beat both → 真實 surprise → 股價漲

對動能交易者價值：
  - 進場前確認「真實預期」而非紙上 consensus
  - 跟我們既有的 daysToEarnings + EPS revision 形成完整 earnings catalyst：
    * 何時公佈（daysToEarnings）— 既有
    * 分析師持續上修？（EPS revision）— 既有
    * **市場真實預期是多少？（Whisper number）— 本檔新增**

資料源：earningswhispers.com 公開頁面 — 他們有 anti-bot 但 calendar 頁面
公開可抓。免費 tier 提供 whisper number + 預估報告時間 + 過去 8 季的
beat/miss history。

對 US scan top 50 + leaders + discoveries 抓 whisper。

Output: data/earnings_whisper.json
{
  generatedAt,
  bySymbol: {
    "NVDA": {
      reportDate:    "2026-05-28",       # 預估報告日期
      reportTime:    "AMC" | "BMO",      # After market close / Before market open
      whisperEPS:    1.65,               # Whisper number
      consensusEPS:  1.50,               # 官方 consensus
      whisperBeat:   0.15,               # whisper - consensus
      beatRate8q:    0.625,              # 過去 8 季 beat whisper 機率
      avgSurprise:   3.2,                # 平均 surprise %
      conviction:    'strong' | 'beat-likely' | 'neutral' | 'miss-likely'
    }
  }
}
"""
import json
import sys
import time
import urllib.request
import urllib.parse
import re
from datetime import datetime, timedelta
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / 'data'
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / 'earnings_whisper.json'

# Public per-ticker page on earningswhispers.com
WHISPER_URL = 'https://www.earningswhispers.com/stocks/{symbol}'

# User-Agent rotation to avoid anti-bot
UAS = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
]

def fetch_html(symbol, idx=0):
    url = WHISPER_URL.format(symbol=symbol.upper())
    req = urllib.request.Request(url, headers={
        'User-Agent': UAS[idx % len(UAS)],
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.earningswhispers.com/',
    })
    try:
        with urllib.request.urlopen(req, timeout=12) as r:
            return r.read().decode('utf-8', errors='replace')
    except Exception as e:
        print(f'    fetch fail {symbol}: {str(e)[:60]}')
        return None

def parse_whisper(html, symbol):
    """
    EarningsWhispers 頁面是 server-rendered HTML，欄位在 specific class names。
    抓：reportDate / reportTime / whisperEPS / consensusEPS / beatRate8q
    """
    if not html:
        return None

    result = {}

    # Report date: "Earnings Date: May 28, 2026" or similar
    m = re.search(r'Earnings Date[^<]*<[^>]*>([A-Za-z]+ \d{1,2}, \d{4})', html)
    if not m:
        m = re.search(r'class="cdate"[^>]*>([^<]+)<', html)
    if m:
        try:
            dt = datetime.strptime(m.group(1).strip(), '%B %d, %Y')
            result['reportDate'] = dt.strftime('%Y-%m-%d')
        except Exception:
            pass

    # Report time: AMC / BMO
    if re.search(r'\bAMC\b|after.{0,10}close', html, re.IGNORECASE):
        result['reportTime'] = 'AMC'
    elif re.search(r'\bBMO\b|before.{0,10}open', html, re.IGNORECASE):
        result['reportTime'] = 'BMO'
    elif re.search(r'during.{0,10}market', html, re.IGNORECASE):
        result['reportTime'] = 'DMH'

    # Whisper EPS: typically labelled "Whisper" near a $X.XX
    m = re.search(r'[Ww]hisper[^$]{0,40}\$?([+-]?\d+\.\d+)', html)
    if m:
        try:
            result['whisperEPS'] = float(m.group(1))
        except Exception:
            pass

    # Consensus EPS: usually labelled "Consensus" or "Estimate"
    m = re.search(r'(?:[Cc]onsensus|[Ee]stimate)[^$]{0,40}\$?([+-]?\d+\.\d+)', html)
    if m:
        try:
            result['consensusEPS'] = float(m.group(1))
        except Exception:
            pass

    # Beat rate (past 8 quarters): "beat 5 of last 8 quarters" or "62.5%"
    m = re.search(r'(?:beat|surpassed)[^0-9]{0,20}(\d)[^0-9]{0,5}of[^0-9]{0,5}(?:last\s+)?(\d)', html, re.IGNORECASE)
    if m:
        try:
            n_beat = int(m.group(1))
            n_total = int(m.group(2))
            if n_total > 0:
                result['beatRate8q'] = n_beat / n_total
        except Exception:
            pass

    # Average surprise %
    m = re.search(r'(?:average|avg)[^%]{0,30}surprise[^0-9-]{0,10}([+-]?\d+\.\d+)\s*%', html, re.IGNORECASE)
    if m:
        try:
            result['avgSurprise'] = float(m.group(1))
        except Exception:
            pass

    # Derived: whisperBeat + conviction
    if 'whisperEPS' in result and 'consensusEPS' in result:
        result['whisperBeat'] = round(result['whisperEPS'] - result['consensusEPS'], 4)

    # Conviction classification
    br = result.get('beatRate8q')
    avgs = result.get('avgSurprise', 0)
    wb = result.get('whisperBeat', 0)
    if br is not None:
        if br >= 0.75 and avgs > 2 and wb > 0:
            result['conviction'] = 'strong'
        elif br >= 0.625 and wb >= 0:
            result['conviction'] = 'beat-likely'
        elif br <= 0.375 or (avgs < -1 and wb < 0):
            result['conviction'] = 'miss-likely'
        else:
            result['conviction'] = 'neutral'

    return result if result else None

def main():
    # Determine target tickers
    targets = []
    scan_file = DATA_DIR / 'us_scan.json'
    if scan_file.exists():
        try:
            scan = json.loads(scan_file.read_text())
            seen = set()
            for r in (scan.get('leaders', []) or []) + (scan.get('discoveries', []) or []):
                sym = r.get('symbol')
                if sym and '.' not in sym and sym not in seen:
                    seen.add(sym)
                    targets.append(sym)
                if len(targets) >= 50:
                    break
        except Exception as e:
            print(f'scan load fail: {e}')

    # Also include popular high-volatility names
    extras = ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'META', 'GOOGL', 'AMZN', 'AMD', 'AVGO', 'NFLX',
              'PLTR', 'COIN', 'MSTR', 'CRWD', 'SNOW', 'CRM', 'ORCL']
    for s in extras:
        if s not in targets:
            targets.append(s)

    targets = targets[:60]
    print(f'Fetching Earnings Whisper for {len(targets)} US tickers...')
    by_symbol = {}
    for i, sym in enumerate(targets):
        html = fetch_html(sym, i)
        if not html:
            continue
        parsed = parse_whisper(html, sym)
        if parsed and ('whisperEPS' in parsed or 'reportDate' in parsed):
            by_symbol[sym] = parsed
            print(f'  [{i+1}/{len(targets)}] {sym}: '
                  f'whisper={parsed.get("whisperEPS","?")} '
                  f'cons={parsed.get("consensusEPS","?")} '
                  f'date={parsed.get("reportDate","?")} '
                  f'conv={parsed.get("conviction","?")}')
        # Polite: 1.5s between requests
        time.sleep(1.5)
        # Occasional longer pause to avoid anti-bot
        if (i + 1) % 10 == 0:
            time.sleep(3)

    out = {
        'generatedAt': int(time.time() * 1000),
        'count': len(by_symbol),
        'bySymbol': by_symbol,
    }
    OUT.write_text(json.dumps(out, indent=2, ensure_ascii=False))
    strong = [s for s, v in by_symbol.items() if v.get('conviction') == 'strong']
    beat_likely = [s for s, v in by_symbol.items() if v.get('conviction') == 'beat-likely']
    print(f'\n✅ Wrote earnings_whisper.json: {len(by_symbol)} tickers')
    print(f'   strong (beat>75% + +surprise + whisper>cons): {len(strong)} → {strong[:5]}')
    print(f'   beat-likely (beat>62.5%): {len(beat_likely)} → {beat_likely[:5]}')

if __name__ == '__main__':
    main()
