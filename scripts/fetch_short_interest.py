#!/usr/bin/env python3
"""
fetch_short_interest.py — 美股 short interest（空單部位）

FINRA 每月公布 2 次（每月 15 號 + 月底），約 2-3 週後上線。
我們從 yfinance 拿（他用 FINRA + Yahoo 自己彙整），免費 + 不需 key。

對動能交易為什麼有用：
  - 高 SI (>20%) + 高 RS → 空頭可能被迫補空 = squeeze potential
  - 高 SI + Days-to-Cover >5 → 大量空單 + 補空需時 → 更暴力 squeeze
  - 低 SI + 高 RS → 純動能上漲（沒空頭 fuel，較難爆衝）
  - 高 SI + 弱 RS → 空頭看對了，避免

我們對 us_scan.json top 50 + leaders + discoveries 全部抓 SI。

Output: data/short_interest.json
{
  generatedAt,
  bySymbol: {
    "GME": {
      shortPercent: 22.5,           # % of float short
      shortRatio: 6.2,              # days to cover
      sharesShort: 12500000,
      reportDate: "2026-05-15",
      squeezeScore: 85,             # 0-100 自家算的
      conviction: 'squeeze_setup' | 'high_si' | 'normal'
    }
  }
}
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

# Lazy import yfinance for env where it's not installed
try:
    import yfinance as yf
except ImportError:
    print('yfinance required: pip install yfinance')
    sys.exit(1)

DATA_DIR = Path(__file__).resolve().parent.parent / 'data'
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / 'short_interest.json'

def calc_squeeze_score(short_pct, short_ratio, rs_rating=None):
    """
    Squeeze 評分公式（0-100）：
      - shortPercent 越高分越高（每 5% = 15 分）
      - shortRatio (days to cover) 越高分越高（每 1 day = 8 分）
      - 如果有 RS Rating，RS >80 加 bonus
    """
    if not short_pct:
        return 0
    score = 0
    score += min(60, short_pct * 3)        # max 60 (at 20% SI)
    score += min(30, (short_ratio or 0) * 6) # max 30 (at 5 days)
    if rs_rating and rs_rating >= 80:
        score += 10  # RS bonus
    return int(min(100, score))

def classify(short_pct, squeeze_score):
    if squeeze_score >= 70 and short_pct >= 15:
        return 'squeeze_setup'
    if short_pct >= 15:
        return 'high_si'
    if short_pct >= 8:
        return 'moderate_si'
    return 'normal'

def main():
    # Determine target tickers
    targets = set()
    scan_file = DATA_DIR / 'us_scan.json'
    if scan_file.exists():
        try:
            scan = json.loads(scan_file.read_text())
            for r in (scan.get('leaders', []) or []) + (scan.get('discoveries', []) or []):
                sym = r.get('symbol')
                if sym and '.' not in sym:
                    targets.add(sym)
        except Exception as e:
            print(f'scan load fail: {e}')

    # Add a curated list of squeeze candidates that often have high SI
    targets.update(['GME', 'AMC', 'BBBY', 'MSTR', 'PLTR', 'AI', 'BYND', 'WKHS',
                     'CVNA', 'UPST', 'AFRM', 'HOOD', 'COIN'])

    # Cap to avoid yfinance throttling
    targets = list(targets)[:80]
    print(f'Fetching short interest for {len(targets)} US tickers via yfinance...')

    # Load existing RS data if any for squeeze score
    rs_map = {}
    if scan_file.exists():
        try:
            scan = json.loads(scan_file.read_text())
            for r in (scan.get('leaders', []) or []) + (scan.get('discoveries', []) or []):
                sym = r.get('symbol')
                if sym:
                    rs_map[sym] = r.get('rsRating')
        except Exception:
            pass

    by_symbol = {}
    for i, sym in enumerate(targets):
        try:
            t = yf.Ticker(sym)
            info = t.info if hasattr(t, 'info') else {}
            short_pct_float = info.get('shortPercentOfFloat')
            short_ratio = info.get('shortRatio')
            shares_short = info.get('sharesShort')
            short_date = info.get('dateShortInterest')
            if short_pct_float is None and shares_short is None:
                continue
            # shortPercentOfFloat is 0-1 from yfinance, convert to %
            short_pct = (short_pct_float or 0) * 100
            squeeze = calc_squeeze_score(short_pct, short_ratio, rs_map.get(sym))
            by_symbol[sym] = {
                'shortPercent':  round(short_pct, 2),
                'shortRatio':    round(short_ratio or 0, 2),
                'sharesShort':   int(shares_short or 0),
                'reportDate':    str(short_date) if short_date else '',
                'squeezeScore':  squeeze,
                'conviction':    classify(short_pct, squeeze),
            }
        except Exception as e:
            pass
        if (i + 1) % 10 == 0:
            print(f'  [{i+1}/{len(targets)}] processed')
            time.sleep(1)

    out = {
        'generatedAt': int(time.time() * 1000),
        'count': len(by_symbol),
        'bySymbol': by_symbol,
    }
    OUT.write_text(json.dumps(out, indent=2, ensure_ascii=False))
    squeezes = [s for s, v in by_symbol.items() if v['conviction'] == 'squeeze_setup']
    high_si = [s for s, v in by_symbol.items() if v['conviction'] == 'high_si']
    print(f'✅ Wrote short_interest.json: {len(by_symbol)} tickers')
    print(f'   squeeze_setup: {len(squeezes)} (SI ≥15% + score ≥70)')
    print(f'   high_si: {len(high_si)} (SI ≥15%)')
    if squeezes[:5]:
        print(f'   squeeze examples: {squeezes[:5]}')

if __name__ == '__main__':
    main()
