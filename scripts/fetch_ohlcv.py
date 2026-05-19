#!/usr/bin/env python3
"""
fetch_ohlcv.py — Bulk-fetch OHLCV via yfinance, write to ohlcv_cache.json.

Why this exists: Yahoo Finance has aggressively blocked node-fetch traffic from
GitHub Actions runners (returns 429 to ~100% of attempts), but the Python
`yfinance` library uses different request patterns and successfully retrieves
data from the same runners.

Architecture:
1. This script fetches OHLCV for the static universe + benchmark ETFs via yfinance
2. Writes to data/ohlcv_cache.json in the format scan.js expects
3. scan.js reads from cache; never makes Yahoo chart calls directly

Cache format (matches scan.js getOHLCVCached):
{
  "AAPL": {
    "fetchedAt": <unix_ms>,
    "data": {
      "closes": [...], "highs": [...], "lows": [...], "opens": [...],
      "volumes": [...], "meta": {"symbol": "AAPL", "shortName": "AAPL"}
    }
  }
}
"""
import yfinance as yf
import pandas as pd
import json, sys, time, os
from pathlib import Path
from datetime import datetime, timezone

DATA_DIR = Path(__file__).resolve().parent.parent / 'data'
DATA_DIR.mkdir(exist_ok=True)
UNIVERSE_FILE    = DATA_DIR / 'universe_static.json'
UNIVERSE_FILE_TW = DATA_DIR / 'universe_static_tw.json'
CACHE_PATH = DATA_DIR / 'ohlcv_cache.json'

# Benchmark ETFs we always want fresh (used for SPY canary + sectorRS)
# 2026-05-19: added 0050.TW (TW benchmark) so TW scan no longer fails.
# Added TW sector ETFs for TW sector radar.
BENCHMARK_ETFS = [
    # US
    'SPY','SMH','IGV','XLK','XLC','XLY','XLI','XLF','XLB','XLE',
    'IBB','XAR','GDX','XLV','XLP','XLU','XLRE','TAN','QQQ','IWM','DIA',
    # TW sector ETFs (for 板塊雷達 TW)
    '0050.TW','0052.TW','0053.TW','0055.TW','0056.TW',
    '00692.TW','00878.TW','00891.TW','00929.TW','00919.TW',
]

now_ms = int(time.time() * 1000)
now_utc = datetime.now(timezone.utc)

def is_stale(entry, force_max_age_ms=None):
    """Match scan.js _ohlcvCacheStaleness logic."""
    age = now_ms - entry.get('fetchedAt', 0)
    if force_max_age_ms is not None:
        return age > force_max_age_ms
    utc_hour = now_utc.hour
    utc_weekday = now_utc.weekday()  # 0=Mon, 6=Sun
    in_market_hours = utc_weekday < 5 and 13 <= utc_hour < 22
    ttl_ms = (48 * 3600_000) if utc_weekday >= 5 else \
             (4 * 3600_000) if in_market_hours else \
             (12 * 3600_000)
    return age > ttl_ms

# Load existing cache
cache = {}
if CACHE_PATH.exists():
    try:
        cache = json.loads(CACHE_PATH.read_text())
    except Exception as e:
        print(f"WARN: cache parse failed ({e}), starting fresh")

# Build target list — US + TW
universe = []
if UNIVERSE_FILE.exists():
    universe = json.loads(UNIVERSE_FILE.read_text()).get('tickers', [])
else:
    print(f"WARN: {UNIVERSE_FILE} missing — using benchmarks only")
# TW universe (smaller, ~100 tickers)
if UNIVERSE_FILE_TW.exists():
    tw_tickers = json.loads(UNIVERSE_FILE_TW.read_text()).get('tickers', [])
    universe = list(set(universe + tw_tickers))
    print(f"  + TW universe: {len(tw_tickers)} tickers")

all_targets = list({*BENCHMARK_ETFS, *universe})
# Benchmarks use a tighter TTL to keep SPY etc. fresh
benchmark_set = set(BENCHMARK_ETFS)
to_fetch = []
for sym in all_targets:
    e = cache.get(sym)
    if e is None:
        to_fetch.append(sym)
    elif sym in benchmark_set:
        # benchmarks: 2h TTL
        if is_stale(e, force_max_age_ms=2 * 3600_000):
            to_fetch.append(sym)
    else:
        if is_stale(e):
            to_fetch.append(sym)

print(f"Cache: {len(cache)} entries existing, {len(to_fetch)}/{len(all_targets)} need refresh")
if not to_fetch:
    print("All fresh — nothing to fetch.")
    sys.exit(0)

# Fetch in chunks (yfinance handles 100-200 tickers per call well)
BATCH = 100
fetched = 0
failed = []

for i in range(0, len(to_fetch), BATCH):
    chunk = to_fetch[i:i + BATCH]
    print(f"[{i+1:4d}-{i+len(chunk):4d}/{len(to_fetch)}] downloading {len(chunk)} tickers...", flush=True)
    try:
        df = yf.download(
            chunk,
            period='1y',
            interval='1d',
            progress=False,
            group_by='ticker',
            threads=10,
            auto_adjust=False,
        )
    except Exception as e:
        print(f"  batch error: {e}")
        for sym in chunk:
            failed.append(sym)
        continue

    for sym in chunk:
        try:
            # When there's only 1 ticker, df is flat (no MultiIndex)
            if len(chunk) == 1:
                sub = df
            else:
                # MultiIndex: top level = ticker
                sub = df[sym] if sym in df.columns.get_level_values(0) else None
            if sub is None:
                failed.append(sym); continue
            sub = sub.dropna(how='all')
            if len(sub) < 60:
                failed.append(sym); continue
            cache[sym] = {
                'fetchedAt': now_ms,
                'data': {
                    'closes': [float(x) for x in sub['Close'].dropna()],
                    'highs':  [float(x) for x in sub['High'].dropna()],
                    'lows':   [float(x) for x in sub['Low'].dropna()],
                    'opens':  [float(x) for x in sub['Open'].dropna()],
                    'volumes':[int(x)  for x in sub['Volume'].dropna()],
                    'meta':   {'symbol': sym, 'shortName': sym},
                },
            }
            fetched += 1
        except Exception as e:
            failed.append(sym)

# Bounded size: drop oldest if cache exceeds ~2000 entries
if len(cache) > 2000:
    sorted_keys = sorted(cache.keys(), key=lambda k: cache[k].get('fetchedAt', 0))
    for k in sorted_keys[:len(cache) - 2000]:
        del cache[k]

CACHE_PATH.write_text(json.dumps(cache))
sz = CACHE_PATH.stat().st_size / 1024 / 1024
print(f"\n✅ Wrote {len(cache)} entries to ohlcv_cache.json ({sz:.1f} MB)")
print(f"   fetched={fetched}, failed={len(failed)} ({100*len(failed)/max(len(to_fetch),1):.0f}%)")
if failed[:10]:
    print(f"   sample failures: {failed[:10]}")

# Sector Radar data (frontend reads this — avoids Yahoo IP-ban on user's browser)
SECTOR_RADAR_ETFS = [
    {'sym':'SMH', 'name':'半導體',    'group':'growth'},
    {'sym':'IGV', 'name':'AI軟體',    'group':'growth'},
    {'sym':'XLK', 'name':'科技',      'group':'growth'},
    {'sym':'XLC', 'name':'通訊服務',  'group':'growth'},
    {'sym':'XLY', 'name':'非必需消費','group':'growth'},
    {'sym':'XLI', 'name':'工業',      'group':'neutral'},
    {'sym':'XLF', 'name':'金融',      'group':'neutral'},
    {'sym':'XLB', 'name':'材料',      'group':'neutral'},
    {'sym':'XLE', 'name':'能源',      'group':'neutral'},
    {'sym':'IBB', 'name':'生技',      'group':'neutral'},
    {'sym':'XAR', 'name':'太空國防',  'group':'growth'},
    {'sym':'GDX', 'name':'礦業黃金',  'group':'defensive'},
    {'sym':'XLV', 'name':'醫療保健',  'group':'defensive'},
    {'sym':'XLP', 'name':'必需消費',  'group':'defensive'},
    {'sym':'XLRE','name':'房地產',    'group':'defensive'},
    {'sym':'XLU', 'name':'公用事業',  'group':'defensive'},
]

sector_radar = []
for etf in SECTOR_RADAR_ETFS:
    sym = etf['sym']
    entry = cache.get(sym)
    if not entry or not entry.get('data'):
        sector_radar.append({**etf, 'price':0, 'changePct':0, 'distHigh':None, '_failed':True})
        continue
    closes = entry['data'].get('closes') or []
    highs = entry['data'].get('highs') or []
    if len(closes) < 2:
        sector_radar.append({**etf, 'price':0, 'changePct':0, 'distHigh':None, '_failed':True})
        continue
    price = closes[-1]
    prev_close = closes[-2]
    change_pct = (price - prev_close) / prev_close * 100 if prev_close else 0
    high52w = max(highs[-252:]) if highs else price
    dist_high = (price - high52w) / high52w * 100 if high52w else None
    sector_radar.append({
        **etf,
        'price':     round(price, 2),
        'changePct': round(change_pct, 2),
        'distHigh':  round(dist_high, 2) if dist_high is not None else None,
        '_failed':   False,
    })

SECTOR_RADAR_PATH = DATA_DIR / 'sector_radar.json'
SECTOR_RADAR_PATH.write_text(json.dumps({
    'generatedAt': now_ms,
    'sectors':     sector_radar,
}, indent=2))
print(f"✅ Wrote sector_radar.json ({sum(1 for s in sector_radar if not s['_failed'])}/{len(sector_radar)} ETFs)")

# 2026-05-19: TW 板塊雷達 — Taiwan-listed sector ETFs
TW_SECTOR_RADAR_ETFS = [
    {'sym': '0050.TW',  'name': '台灣 50',       'group': 'broad'},
    {'sym': '0056.TW',  'name': '高股息',         'group': 'dividend'},
    {'sym': '0052.TW',  'name': '科技',           'group': 'growth'},
    {'sym': '0053.TW',  'name': '中型 100',       'group': 'broad'},
    {'sym': '0055.TW',  'name': '金融',           'group': 'financial'},
    {'sym': '00692.TW', 'name': '公司治理 100',   'group': 'broad'},
    {'sym': '00878.TW', 'name': '國泰永續高股息', 'group': 'dividend'},
    {'sym': '00891.TW', 'name': '中信半導體',     'group': 'growth'},
    {'sym': '00929.TW', 'name': '復華台灣科技',   'group': 'growth'},
    {'sym': '00919.TW', 'name': '群益台灣精選高息', 'group': 'dividend'},
]

tw_radar = []
for etf in TW_SECTOR_RADAR_ETFS:
    sym = etf['sym']
    entry = cache.get(sym)
    if not entry or not entry.get('data'):
        tw_radar.append({**etf, 'price': 0, 'changePct': 0, 'distHigh': None, '_failed': True})
        continue
    closes = entry['data'].get('closes') or []
    highs  = entry['data'].get('highs')  or []
    if len(closes) < 2:
        tw_radar.append({**etf, 'price': 0, 'changePct': 0, 'distHigh': None, '_failed': True})
        continue
    price = closes[-1]
    prev_close = closes[-2]
    change_pct = (price - prev_close) / prev_close * 100 if prev_close else 0
    high52w = max(highs[-252:]) if highs else price
    dist_high = (price - high52w) / high52w * 100 if high52w else None
    tw_radar.append({
        **etf,
        'price':     round(price, 2),
        'changePct': round(change_pct, 2),
        'distHigh':  round(dist_high, 2) if dist_high is not None else None,
        '_failed':   False,
    })

TW_RADAR_PATH = DATA_DIR / 'tw_sector_radar.json'
TW_RADAR_PATH.write_text(json.dumps({
    'generatedAt': now_ms,
    'sectors':     tw_radar,
}, indent=2, ensure_ascii=False))
print(f"✅ Wrote tw_sector_radar.json ({sum(1 for s in tw_radar if not s['_failed'])}/{len(tw_radar)} TW ETFs)")
