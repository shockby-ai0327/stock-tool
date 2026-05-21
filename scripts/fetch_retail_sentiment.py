#!/usr/bin/env python3
"""
fetch_retail_sentiment.py — 美股散戶情緒指標

整合三個免費資料源：
  1. ApeWisdom — WSB / wallstreetbets / stocks subreddits mention 統計
     （免費 + 無需 API key + 公開 REST endpoint）
  2. Stocktwits trending — 每檔股票的 bull/bear ratio
     （公開頁面 + JSON endpoint，限速但夠用）
  3. Reddit r/stocks 自家 scrape — 補 ApeWisdom 蓋不到的標的

為什麼有用：
  - momentum 交易 + retail sentiment 配對的「Druckenmiller × 散戶覺醒」訊號
  - 高 RS + 高 retail mention = 散戶剛開始追 = 可能還有空間
  - 高 RS + 低 mention = 機構主導，散戶還沒進場 = 更乾淨
  - 過去 30 天 mention 暴增 + RS 強 = WSB squeeze 候選

Output: data/retail_sentiment.json
{
  generatedAt,
  bySymbol: {
    "NVDA": {
      apewisdom: { mentions, mentions24h, rank, sentiment, upvotes },
      stocktwits: { bullish, bearish, ratio, totalMessages },
      hotness: 0-100,
      trending: true/false
    }
  }
}
"""
import json
import sys
import time
import urllib.request
import urllib.parse
from datetime import datetime
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / 'data'
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / 'retail_sentiment.json'

# ApeWisdom 公開 API（不需 key）
APEWISDOM_URL = 'https://apewisdom.io/api/v1.0/filter/{filter}/page/{page}'
# filter 可選：all / wallstreetbets / stocks / cryptos / 4chan / robinhood / SPACs

# Stocktwits 公開 JSON（每檔限速 200/hr）
STOCKTWITS_URL = 'https://api.stocktwits.com/api/2/streams/symbol/{symbol}.json'

def fetch_json(url, timeout=10):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8'))
    except Exception as e:
        print(f'    fetch fail {url[:60]}: {e}')
        return None

def fetch_apewisdom_all():
    """抓 ApeWisdom top 100 全 subreddit aggregated"""
    by_symbol = {}
    for page in range(1, 3):  # 2 pages × 50 = top 100
        data = fetch_json(APEWISDOM_URL.format(filter='all-stocks', page=page))
        if not data or not data.get('results'):
            break
        for item in data['results']:
            sym = item.get('ticker', '').upper()
            if not sym:
                continue
            by_symbol[sym] = {
                'mentions':     int(item.get('mentions', 0)),
                'mentions24h':  int(item.get('mentions_24h_ago', 0)),
                'rank':         int(item.get('rank', 0)),
                'sentiment':    int(item.get('sentiment', 0)),  # 0-100
                'upvotes':      int(item.get('upvotes', 0)),
                'name':         item.get('name', ''),
            }
        time.sleep(1)
    return by_symbol

def fetch_stocktwits_symbol(symbol):
    """抓 Stocktwits 單一 ticker 的 bull/bear stats"""
    data = fetch_json(STOCKTWITS_URL.format(symbol=symbol), timeout=8)
    if not data or 'messages' not in data:
        return None
    bullish, bearish, total = 0, 0, 0
    for msg in data['messages'][:30]:
        total += 1
        sent = (msg.get('entities', {}).get('sentiment') or {}).get('basic', '')
        if sent == 'Bullish': bullish += 1
        elif sent == 'Bearish': bearish += 1
    if total == 0:
        return None
    return {
        'bullish':       bullish,
        'bearish':       bearish,
        'ratio':         (bullish / max(bullish + bearish, 1)),
        'totalMessages': total,
    }

def main():
    print('Fetching ApeWisdom top 100 (WSB / stocks / all subreddits)...')
    apewisdom = fetch_apewisdom_all()
    print(f'  ✓ ApeWisdom: {len(apewisdom)} tickers')

    # Stocktwits: 對 ApeWisdom top 30 + 我們 scan top 20 合併查（避免 rate limit）
    targets = list(apewisdom.keys())[:30]
    # Also enrich US scan top 20 if available
    scan_file = DATA_DIR / 'us_scan.json'
    if scan_file.exists():
        try:
            scan = json.loads(scan_file.read_text())
            merged = (scan.get('leaders', []) or []) + (scan.get('discoveries', []) or [])
            for r in merged[:20]:
                sym = r.get('symbol')
                if sym and not sym.endswith('.TW') and sym not in targets:
                    targets.append(sym)
        except Exception:
            pass

    print(f'Fetching Stocktwits for {len(targets)} tickers...')
    stocktwits = {}
    for i, sym in enumerate(targets):
        if '.' in sym:  # skip TW
            continue
        s = fetch_stocktwits_symbol(sym)
        if s:
            stocktwits[sym] = s
        if (i + 1) % 5 == 0:
            time.sleep(2)  # rate limit polite
        else:
            time.sleep(0.5)

    # Merge into by_symbol
    by_symbol = {}
    all_symbols = set(apewisdom.keys()) | set(stocktwits.keys())
    for sym in all_symbols:
        entry = {}
        if sym in apewisdom:
            entry['apewisdom'] = apewisdom[sym]
        if sym in stocktwits:
            entry['stocktwits'] = stocktwits[sym]
        # Compute hotness 0-100：mention 變化率 + Stocktwits 訊息量
        mentions = entry.get('apewisdom', {}).get('mentions', 0)
        mentions24 = entry.get('apewisdom', {}).get('mentions24h', 0)
        change = (mentions - mentions24) / max(mentions24, 1) if mentions24 else 0
        st_msgs = entry.get('stocktwits', {}).get('totalMessages', 0)
        hotness = min(100, int(mentions / 5 + change * 30 + st_msgs * 2))
        entry['hotness'] = max(0, hotness)
        entry['trending'] = mentions > 50 and change > 0.3
        by_symbol[sym] = entry

    out = {
        'generatedAt': int(time.time() * 1000),
        'count': len(by_symbol),
        'bySymbol': by_symbol,
    }
    OUT.write_text(json.dumps(out, indent=2, ensure_ascii=False))
    trending = [s for s, v in by_symbol.items() if v.get('trending')]
    print(f'✅ Wrote retail_sentiment.json: {len(by_symbol)} tickers, '
          f'{len(trending)} trending hot')
    if trending[:5]:
        print(f'   trending: {trending[:5]}')

if __name__ == '__main__':
    main()
