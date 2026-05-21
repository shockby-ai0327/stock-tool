#!/usr/bin/env python3
"""
fetch_politician_trades.py — 美國國會議員交易揭露（STOCK Act 強制）

Capitol Trades 收集所有 senator/representative 的個股交易揭露（PTR forms），
免費 + 無 API key + 無 rate limit（HTML scraping，他們不擋）。

Pelosi 等知名議員的 portfolio 在 2020-2024 期間 outperform S&P 50%+ —
雖然他們否認 insider 但統計上明顯有 edge。也是 Trump 時代後 retail 跟單熱點。

我們只抓最近 30 天 + 過濾 stock buy（不要 ETF / option / sell），
然後對每檔股票統計：
  - howManyPoliticians: 過去 30 天有幾位議員買進
  - lastBuyDate: 最近一次買進日期
  - politicianNames: 議員名單（最多 3 個）

Output: data/politician_trades.json
{
  generatedAt, lookbackDays: 30,
  bySymbol: {
    "NVDA": {
      buys: 5,
      politicians: ["Nancy Pelosi", "Dan Crenshaw", ...],
      lastBuyDate: "2026-05-15",
      latestPolitician: "Nancy Pelosi"
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
OUT = DATA_DIR / 'politician_trades.json'

# Capitol Trades 公開頁面 — 過去 30 天所有 buy transactions
# 注意：他們不歡迎大量 scraping，請保守用（一天 1-2 次）
CAPITOL_URL = 'https://www.capitoltrades.com/trades?txType=buy&pageSize=96&page={page}'

def fetch_html(url):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.read().decode('utf-8', errors='replace')
    except Exception as e:
        print(f'  fetch fail: {e}')
        return None

def parse_trades_page(html):
    """
    Capitol Trades 用 Next.js，初始資料在 __NEXT_DATA__ <script> 裡。
    比對最近 30 天 trades，過濾 stock + buy。
    """
    trades = []
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
    if not m:
        return trades
    try:
        data = json.loads(m.group(1))
        # 結構：props.pageProps.trades 或 props.pageProps.initialData.trades
        items = (data.get('props', {})
                     .get('pageProps', {})
                     .get('trades', []))
        if not items:
            items = (data.get('props', {})
                         .get('pageProps', {})
                         .get('initialData', {})
                         .get('trades', []))
        for t in items:
            asset_type = (t.get('asset', {}).get('assetType') or '').lower()
            if asset_type not in ('stock', 'common stock', 'equity'):
                continue
            symbol = (t.get('asset', {}).get('assetTicker') or '').strip().upper()
            if not symbol or '.' in symbol:
                continue
            politician = (t.get('politician', {}).get('fullName') or '').strip()
            tx_type = (t.get('txType') or '').lower()
            if tx_type != 'buy':
                continue
            tx_date = t.get('txDate') or t.get('filedDate') or ''
            trades.append({
                'symbol':     symbol,
                'politician': politician,
                'date':       tx_date[:10],
            })
    except Exception as e:
        print(f'  parse fail: {e}')
    return trades

def main():
    cutoff = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')
    print(f'Fetching Capitol Trades (last 30d, since {cutoff})...')
    all_trades = []
    for page in range(1, 4):  # 3 pages × 96 = 288 trades 通常涵蓋 30 天
        url = CAPITOL_URL.format(page=page)
        html = fetch_html(url)
        if not html:
            break
        trades = parse_trades_page(html)
        print(f'  page {page}: parsed {len(trades)} buy trades')
        if not trades:
            break
        all_trades.extend(trades)
        # 如果這頁最舊的已超過 30 天前，就停
        if trades and trades[-1]['date'] < cutoff:
            break
        time.sleep(2)

    # Aggregate by symbol
    by_symbol = {}
    for t in all_trades:
        if t['date'] < cutoff:
            continue
        sym = t['symbol']
        if sym not in by_symbol:
            by_symbol[sym] = {
                'buys':            0,
                'politicians':     [],
                'lastBuyDate':     '',
                'latestPolitician':'',
            }
        b = by_symbol[sym]
        b['buys'] += 1
        if t['politician'] not in b['politicians']:
            b['politicians'].append(t['politician'])
        if t['date'] > b['lastBuyDate']:
            b['lastBuyDate'] = t['date']
            b['latestPolitician'] = t['politician']
    # Truncate politicians list to 3
    for v in by_symbol.values():
        v['politicians'] = v['politicians'][:3]

    out = {
        'generatedAt': int(time.time() * 1000),
        'lookbackDays': 30,
        'count': len(by_symbol),
        'bySymbol': by_symbol,
    }
    OUT.write_text(json.dumps(out, indent=2, ensure_ascii=False))
    cluster_picks = [s for s, v in by_symbol.items() if v['buys'] >= 3]
    print(f'✅ Wrote politician_trades.json: {len(by_symbol)} tickers, '
          f'{len(cluster_picks)} have ≥3 politicians buying')
    if cluster_picks[:5]:
        print(f'   cluster examples: {cluster_picks[:5]}')

if __name__ == '__main__':
    main()
