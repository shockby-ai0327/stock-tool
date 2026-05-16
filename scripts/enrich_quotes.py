#!/usr/bin/env python3
"""
enrich_quotes.py — Post-scan enrichment via Python yfinance.

Runs AFTER scan.js finishes its OHLCV-based ranking. For each leader and
discovery, fetches catalyst data Yahoo's quoteSummary endpoint provides:
  - earnings date / days to earnings
  - short interest (% of float, days to cover)
  - analyst upgrades / downgrades (last 30d)
  - EPS surprise history (last 4 quarters)
  - sector / industry / sector ETF mapping

Then mutates data/us_scan.json in place, and recomputes tripleResonance
candidates (catalyst-aware).

Why Python: Yahoo's quoteSummary endpoint blocks node-fetch from GH Actions
IPs (returns 429), but yfinance uses a request pattern that gets through.
"""
import yfinance as yf
import json
import sys
import time
from pathlib import Path
from datetime import datetime, timezone, timedelta

DATA_DIR     = Path(__file__).resolve().parent.parent / 'data'
SCAN_FILE    = DATA_DIR / 'us_scan.json'
QUOTE_CACHE  = DATA_DIR / 'quote_cache.json'
SECTOR_CACHE = DATA_DIR / 'sector_cache.json'

# Match scan.js mapping tables exactly so the JSON output is consistent
SECTOR_TO_ETF = {
    'Technology':             'XLK',
    'Communication Services': 'XLC',
    'Consumer Cyclical':      'XLY',
    'Consumer Defensive':     'XLP',
    'Financial Services':     'XLF',
    'Healthcare':             'XLV',
    'Industrials':            'XLI',
    'Energy':                 'XLE',
    'Basic Materials':        'XLB',
    'Real Estate':            'XLRE',
    'Utilities':              'XLU',
}

INDUSTRY_TO_ETF = {
    'Semiconductors':                          'SMH',
    'Semiconductor Equipment & Materials':     'SMH',
    'Software—Application':                    'IGV',
    'Software—Infrastructure':                 'IGV',
    'Software - Application':                  'IGV',
    'Software - Infrastructure':               'IGV',
    'Biotechnology':                           'IBB',
    'Drug Manufacturers—Specialty & Generic':  'IBB',
    'Aerospace & Defense':                     'XAR',
    'Gold':                                    'GDX',
    'Silver':                                  'GDX',
    'Other Precious Metals & Mining':          'GDX',
    'Solar':                                   'TAN',
}

def resolve_etf(sector, industry):
    if industry and industry in INDUSTRY_TO_ETF:
        return INDUSTRY_TO_ETF[industry]
    if sector and sector in SECTOR_TO_ETF:
        return SECTOR_TO_ETF[sector]
    return None

def load_json(path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default

scan = load_json(SCAN_FILE, None)
if not scan or 'leaders' not in scan:
    print(f"❌ {SCAN_FILE} missing or invalid")
    sys.exit(1)

quote_cache  = load_json(QUOTE_CACHE,  {})
sector_cache = load_json(SECTOR_CACHE, {})

leaders     = scan.get('leaders', [])
discoveries = scan.get('discoveries', [])
targets = list(dict.fromkeys(
    [r['symbol'] for r in leaders] + [r['symbol'] for r in discoveries]
))
print(f"Enriching {len(targets)} symbols ({len(leaders)} leaders + {len(discoveries)} discoveries)")

now_ms = int(time.time() * 1000)
QUOTE_TTL_MS  = 24 * 3600 * 1000      # 24h
SECTOR_TTL_MS = 365 * 24 * 3600 * 1000  # 1 year

def is_fresh(cache_entry, ttl_ms):
    return cache_entry and (now_ms - cache_entry.get('cachedAt', 0)) < ttl_ms

# Fetch sector benchmarks for sectorRS calculation
# We need 12-1 month return of each sector ETF
benchmarks = {}
sector_etfs_used = set()
for r in leaders + discoveries:
    if r.get('sectorEtf'):
        sector_etfs_used.add(r['sectorEtf'])

def fetch_etf_return(etf):
    try:
        hist = yf.Ticker(etf).history(period='1y', interval='1d')
        if len(hist) < 21:
            return None
        # 12-1 month return: from start to 21 trading days ago
        closes = hist['Close'].dropna()
        if len(closes) < 21:
            return None
        return float((closes.iloc[-21] - closes.iloc[0]) / closes.iloc[0] * 100)
    except Exception:
        return None

# Don't fetch benchmarks here — they're already available via OHLCV cache and
# the existing scan already computed sectorRS for cached ETFs. We just need
# to fill in sector mapping for stocks that didn't have it.

enriched_quote = 0
enriched_sector = 0
failed = []

for i, sym in enumerate(targets, 1):
    needs_quote  = not is_fresh(quote_cache.get(sym),  QUOTE_TTL_MS)
    needs_sector = not is_fresh(sector_cache.get(sym), SECTOR_TTL_MS)
    if not needs_quote and not needs_sector:
        continue
    try:
        t = yf.Ticker(sym)
        info = t.info or {}

        if needs_sector:
            sector   = info.get('sector')
            industry = info.get('industry')
            sector_cache[sym] = {
                'cachedAt': now_ms,
                'sector':   sector,
                'industry': industry,
                'etf':      resolve_etf(sector, industry),
            }
            enriched_sector += 1

        if needs_quote:
            # Earnings date / days to
            earnings_date = None
            days_to_earnings = None
            try:
                cal = t.calendar
                ed = None
                if isinstance(cal, dict):
                    ed = cal.get('Earnings Date')
                if ed:
                    ed_obj = ed[0] if isinstance(ed, (list, tuple)) and ed else ed
                    if hasattr(ed_obj, 'timestamp'):
                        # datetime / Timestamp
                        ed_dt = ed_obj if hasattr(ed_obj, 'tzinfo') else None
                        if hasattr(ed_obj, 'to_pydatetime'):
                            ed_dt = ed_obj.to_pydatetime()
                        elif hasattr(ed_obj, 'year'):
                            ed_dt = datetime(ed_obj.year, ed_obj.month, ed_obj.day, tzinfo=timezone.utc)
                        if ed_dt:
                            earnings_date = int(ed_dt.timestamp())
                            days_to_earnings = (ed_dt.date() - datetime.now(timezone.utc).date()).days
            except Exception:
                pass

            # Upgrade / downgrade history (last 30 days)
            recent_upgrades   = []
            recent_downgrades = []
            try:
                ud = t.upgrades_downgrades
                if ud is not None and len(ud) > 0:
                    cutoff = datetime.now(timezone.utc) - timedelta(days=30)
                    for idx, row in ud.iterrows():
                        dt = idx.to_pydatetime() if hasattr(idx, 'to_pydatetime') else idx
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=timezone.utc)
                        if dt < cutoff:
                            continue
                        firm = str(row.get('Firm', ''))
                        action = str(row.get('Action', '')).lower()
                        entry = {'firm': firm, 'action': str(row.get('Action', '')), 'date': dt.strftime('%Y-%m-%d')}
                        if 'up' in action or 'init' in action:
                            recent_upgrades.append(entry)
                        elif 'down' in action or 'reit' in action:
                            recent_downgrades.append(entry)
                    recent_upgrades   = recent_upgrades[:3]
                    recent_downgrades = recent_downgrades[:3]
            except Exception:
                pass

            # Earnings surprise history (last 4 quarters)
            surprise_history = []
            try:
                eh = t.earnings_history
                if eh is not None and len(eh) > 0:
                    for idx, row in eh.tail(4).iterrows():
                        def _num(k):
                            v = row.get(k)
                            try:
                                return float(v) if v is not None else None
                            except Exception:
                                return None
                        surprise_history.append({
                            'qtr':         str(idx),
                            'actual':      _num('epsActual'),
                            'estimate':    _num('epsEstimate'),
                            'surprisePct': _num('surprisePercent'),
                        })
            except Exception:
                pass

            # Short interest
            short_pct  = info.get('shortPercentOfFloat')
            short_rt   = info.get('shortRatio')

            # Recommendation
            recommendation = None
            try:
                rec = t.recommendations
                if rec is not None and len(rec) > 0:
                    latest = rec.iloc[0]
                    recommendation = {
                        'strongBuy':  int(latest.get('strongBuy', 0) or 0),
                        'buy':        int(latest.get('buy', 0) or 0),
                        'hold':       int(latest.get('hold', 0) or 0),
                        'sell':       int(latest.get('sell', 0) or 0),
                        'strongSell': int(latest.get('strongSell', 0) or 0),
                    }
            except Exception:
                pass

            quote_cache[sym] = {
                'cachedAt': now_ms,
                'data': {
                    'earningsDate':     earnings_date,
                    'daysToEarnings':   days_to_earnings,
                    'shortPctOfFloat':  short_pct,
                    'shortRatio':       short_rt,
                    'recentUpgrades':   recent_upgrades,
                    'recentDowngrades': recent_downgrades,
                    'surpriseHistory':  surprise_history,
                    'recommendation':   recommendation,
                },
            }
            enriched_quote += 1
        # Throttle gently — yfinance has internal rate-limiting
        if i % 5 == 0:
            time.sleep(0.5)
    except Exception as e:
        failed.append((sym, str(e)[:80]))
        continue

QUOTE_CACHE.write_text(json.dumps(quote_cache, default=str))
SECTOR_CACHE.write_text(json.dumps(sector_cache, default=str))
print(f"Cache writes: {enriched_quote} quotes, {enriched_sector} sectors")
if failed[:3]:
    print(f"Sample failures: {failed[:3]}")

# Apply caches to scan records
def apply(record):
    sym = record['symbol']
    if sym in quote_cache:
        q = quote_cache[sym].get('data', {})
        record['earningsDate']     = q.get('earningsDate')
        record['daysToEarnings']   = q.get('daysToEarnings')
        record['shortPctOfFloat']  = q.get('shortPctOfFloat')
        record['shortRatio']       = q.get('shortRatio')
        record['recentUpgrades']   = q.get('recentUpgrades', [])
        record['recentDowngrades'] = q.get('recentDowngrades', [])
        record['surpriseHistory']  = q.get('surpriseHistory', [])
        record['recommendation']   = q.get('recommendation')
    if sym in sector_cache:
        s = sector_cache[sym]
        record['sector']    = s.get('sector')
        record['industry']  = s.get('industry')
        if not record.get('sectorEtf'):
            record['sectorEtf'] = s.get('etf')

for r in leaders:     apply(r)
for r in discoveries: apply(r)

# Recompute tripleResonance with catalyst data filled in
candidates = []
for r in leaders + [d for d in discoveries if not any(l['symbol'] == d['symbol'] for l in leaders)]:
    stars = 0
    reasons = []

    dte = r.get('daysToEarnings')
    if dte is not None and 1 <= dte <= 14:
        stars += 1
        reasons.append(f"財報倒數 {dte} 天")

    vcp_score = r.get('vcpScore') or 0
    if vcp_score >= 2:
        reasons_vcp = f"VCP {vcp_score}/6"
        if r.get('vcpBaseNumber'):
            reasons_vcp += f" (基底 {r['vcpBaseNumber']})"
        stars += 1
        reasons.append(reasons_vcp)

    upgrades = r.get('recentUpgrades') or []
    if len(upgrades) >= 1:
        stars += 1
        reasons.append(f"{len(upgrades)} 位分析師升評")

    if (r.get('rsRating') or 0) >= 80:
        stars += 1
        reasons.append(f"RS {r['rsRating']}")

    if stars >= 3:
        candidates.append({
            'symbol':           r['symbol'],
            'name':             r.get('name', r['symbol']),
            'price':            r.get('price'),
            'rsRating':         r.get('rsRating'),
            'compositeScore':   r.get('compositeScore'),
            'daysToEarnings':   dte,
            'vcpScore':         vcp_score,
            'recentUpgradeCount': len(upgrades),
            'isDiscovery':      not any(l['symbol'] == r['symbol'] for l in leaders),
            'stars':            stars,
            'reasons':          reasons,
        })

candidates.sort(key=lambda x: (-x['stars'], -(x.get('compositeScore') or 0)))
scan['tripleResonance'] = candidates[:15]
print(f"tripleResonance candidates: {len(scan['tripleResonance'])}")

SCAN_FILE.write_text(json.dumps(scan, indent=2))
print(f"✅ Updated {SCAN_FILE.name}")
