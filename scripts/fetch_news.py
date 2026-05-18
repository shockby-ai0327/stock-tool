#!/usr/bin/env python3
"""
fetch_news.py — Fetch recent news headlines via yfinance, dump to JSON.

Why: Yahoo's v1/finance/search endpoint (used by old news_scan.js for headline
fetch) returns 429 to GitHub Actions IPs, same as the chart endpoint.
yfinance's ticker.news uses a different request path that gets through.

Output: data/{market}_news_raw.json
  { generatedAt, bySymbol: { TICKER: [{ title, publisher, link, pubTime }, ...] } }

Then news_scan.js reads this file and only calls Claude for sentiment classification.
"""
import yfinance as yf
import json
import sys
import time
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / 'data'

def main():
    market = (sys.argv[1] if len(sys.argv) > 1 else 'us').lower()
    scan_file = DATA_DIR / f'{market}_scan.json'
    if not scan_file.exists():
        print(f'ERROR: {scan_file} missing — run scan first')
        sys.exit(1)
    scan = json.loads(scan_file.read_text())
    leaders     = scan.get('leaders', [])
    discoveries = scan.get('discoveries', [])
    merged = leaders + discoveries
    # Top 20 by composite score
    merged.sort(key=lambda r: r.get('compositeScore', 0), reverse=True)
    seen = set()
    targets = []
    for r in merged:
        sym = r.get('symbol')
        if sym and sym not in seen:
            seen.add(sym)
            targets.append(sym)
        if len(targets) >= 20:
            break

    print(f'Fetching news for {len(targets)} symbols via yfinance...')
    by_symbol = {}
    for i, sym in enumerate(targets, 1):
        try:
            news_items = yf.Ticker(sym).news or []
            # yfinance returns list of dicts with title, publisher, link, providerPublishTime
            parsed = []
            for item in news_items[:10]:
                # Newer yfinance wraps content in 'content' key
                content = item.get('content', item)
                title = content.get('title') or item.get('title')
                if not title:
                    continue
                parsed.append({
                    'title':     title,
                    'publisher': content.get('provider', {}).get('displayName') if isinstance(content.get('provider'), dict) else (item.get('publisher') or ''),
                    'link':      content.get('canonicalUrl', {}).get('url') if isinstance(content.get('canonicalUrl'), dict) else (item.get('link') or ''),
                    'pubTime':   content.get('pubDate') or item.get('providerPublishTime') or '',
                })
            by_symbol[sym] = parsed
            print(f'  [{i}/{len(targets)}] {sym}: {len(parsed)} headlines')
        except Exception as e:
            print(f'  [{i}/{len(targets)}] {sym}: FAILED — {str(e)[:80]}')
            by_symbol[sym] = []
        # Tiny throttle
        if i % 5 == 0:
            time.sleep(0.3)

    out = {
        'generatedAt': int(time.time() * 1000),
        'market':      market.upper(),
        'bySymbol':    by_symbol,
    }
    out_path = DATA_DIR / f'{market}_news_raw.json'
    out_path.write_text(json.dumps(out, indent=2, ensure_ascii=False))
    total = sum(len(v) for v in by_symbol.values())
    print(f'\nWrote {out_path.name}: {len(by_symbol)} symbols, {total} headlines total')

if __name__ == '__main__':
    main()
