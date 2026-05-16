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
UNIVERSE_FILE = DATA_DIR / 'universe_static.json'
CACHE_PATH = DATA_DIR / 'ohlcv_cache.json'

# Benchmark ETFs we always want fresh (used for SPY canary + sectorRS)
BENCHMARK_ETFS = ['SPY','SMH','IGV','XLK','XLC','XLY','XLI','XLF','XLB','XLE',
                  'IBB','XAR','GDX','XLV','XLP','XLU','XLRE','TAN','QQQ','IWM','DIA']

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

# Build target list
universe = []
if UNIVERSE_FILE.exists():
    universe = json.loads(UNIVERSE_FILE.read_text()).get('tickers', [])
else:
    print(f"WARN: {UNIVERSE_FILE} missing — using benchmarks only")

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
