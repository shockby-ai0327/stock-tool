/**
 * scan.js — Server-side RS Leader + Acceleration Discovery Scanner
 * Runs in GitHub Actions 3×/day, saves to ../data/us_scan.json + tw_scan.json
 *
 * TWO output arrays per scan:
 *   leaders[]     — Confirmed momentum leaders (12-1mo RS, top 25)
 *   discoveries[] — Acceleration candidates (3-mo momentum + accel, top 15)
 *
 * leaders:     IBD-style 12-1 month RS Rating vs benchmark
 * discoveries: Stocks with ≥30% 3-month return + accelerating momentum
 *              (recent 1-month pace > 3-month avg pace × 1.2)
 *              Sorted by acceleration score, excludes leader list duplicates
 */

import fetch from 'node-fetch';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

const DELAY = ms => new Promise(r => setTimeout(r, ms));

// ── JSON file helpers (defensive: missing/corrupt → empty default) ──────────
function loadJSON(filename, fallback) {
  const path = join(DATA_DIR, filename);
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.warn(`  load ${filename} failed: ${e.message} — using fallback`);
    return fallback;
  }
}

function saveJSON(filename, data) {
  writeFileSync(join(DATA_DIR, filename), JSON.stringify(data, null, 2));
}

// ── Yahoo Finance helpers ───────────────────────────────────────────────────

// Modern Chrome UA — required by some Yahoo endpoints since 2023.
const YF_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// In-memory cookie jar + crumb. Yahoo's quoteSummary v10 requires a session
// cookie (set by hitting fc.yahoo.com first) and a "crumb" token (fetched from
// /v1/test/getcrumb). Without both, requests come back HTTP 401.
const yfSession = { cookie: '', crumb: '' };

async function yfInitSession() {
  // Hit a Yahoo property to obtain the A1/A1S cookie. fc.yahoo.com is a
  // beacon endpoint that reliably sets it; finance.yahoo.com also works.
  try {
    const seedRes = await fetch('https://fc.yahoo.com/', {
      headers: { 'User-Agent': YF_UA, 'Accept': '*/*' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    const setCookie = seedRes.headers.raw?.()['set-cookie'] || seedRes.headers.get('set-cookie');
    const cookies = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
    yfSession.cookie = cookies.map(c => c.split(';')[0]).join('; ');
  } catch (e) {
    // Fall back to bare cookie — crumb may not work but other endpoints will.
    yfSession.cookie = '';
  }

  // Fetch crumb token. Requires the cookie set above.
  try {
    const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: {
        'User-Agent': YF_UA,
        'Accept': '*/*',
        'Cookie': yfSession.cookie,
      },
      signal: AbortSignal.timeout(10000),
    });
    if (crumbRes.ok) {
      const text = (await crumbRes.text()).trim();
      // Crumb is a short token (~11 chars), not an HTML error page.
      if (text && text.length < 40 && !text.startsWith('<')) {
        yfSession.crumb = text;
      }
    }
  } catch (e) { /* leave crumb empty, quoteSummary calls will fail gracefully */ }

  console.log(`  YF session: cookie=${yfSession.cookie ? 'set' : 'missing'} crumb=${yfSession.crumb ? 'set' : 'missing'}`);
}

// 2026-05-16 CRITICAL FIX: split into two fetchers.
// - yfFetchPlain: chart + screener endpoints. NO cookie. Always worked, always will.
// - yfFetch: quoteSummary v10 only. Sends cookie + crumb required by Yahoo.
// The Wave 1 mistake was using one cookie-bearing fetcher for everything — Yahoo's
// chart endpoint started returning empty results when our cookie was malformed.
async function yfFetchPlain(url, retries = 3) {
  const headers = {
    'User-Agent': YF_UA,
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (res.status === 404) throw new Error('HTTP 404');
      if (res.status === 429) { await DELAY((i + 1) * 2000); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await DELAY(600 * (i + 1));
    }
  }
}

async function yfFetch(url, retries = 3) {
  const headers = {
    'User-Agent': YF_UA,
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (yfSession.cookie) headers['Cookie'] = yfSession.cookie;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      // Fail fast on auth errors — retrying won't fix 401/403/404.
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (res.status === 429) {
        await DELAY((i + 1) * 2000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await DELAY(800 * (i + 1));
    }
  }
}

// Add the crumb to quoteSummary URLs. Other endpoints (chart, screener) do not
// require a crumb.
function withCrumb(url) {
  if (!yfSession.crumb) return url;
  return url + (url.includes('?') ? '&' : '?') + 'crumb=' + encodeURIComponent(yfSession.crumb);
}

// OHLCV via v8/finance/chart — no auth required (use plain fetcher, no cookie)
async function getOHLCV(symbol, range = '12mo') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}&includePrePost=false`;
  const data = await yfFetchPlain(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error('no data');
  const oq = result.indicators.quote[0];
  return {
    closes:  oq.close.filter(v => v != null),
    opens:   (oq.open  || []).filter(v => v != null),
    highs:   oq.high.filter(v => v != null),
    lows:    oq.low.filter(v => v != null),
    volumes: oq.volume.filter(v => v != null),
    meta:    result.meta,
  };
}

// OHLCV cache with TTL — daily resolution data only changes once/day after close.
// Refresh policy:
//   • Cache > 4h old during US market hours (UTC 13:30-21:00 weekdays) → refresh
//   • Cache > 12h old after hours → refresh
//   • Cache > 48h old weekend → refresh
// Saves ~60-80% of OHLCV fetches on warm runs.
function _ohlcvCacheStaleness(cachedAt) {
  if (!cachedAt) return Infinity;
  const age = Date.now() - cachedAt;
  const d = new Date();
  const utcHour = d.getUTCHours(), utcDay = d.getUTCDay(); // 0=Sun, 6=Sat
  const inMarketHours = utcDay >= 1 && utcDay <= 5 && utcHour >= 13 && utcHour < 22;
  const ttl = utcDay === 0 || utcDay === 6 ? 48 * 3600e3
            : inMarketHours                ? 4 * 3600e3
            :                                12 * 3600e3;
  return age - ttl; // positive = stale
}

async function getOHLCVCached(symbol, ohlcvCache) {
  const cached = ohlcvCache[symbol];
  if (cached && _ohlcvCacheStaleness(cached.fetchedAt) < 0) {
    return { ...cached.data, _fromCache: true };
  }
  const fresh = await getOHLCV(symbol, '12mo');
  // Only cache if we got a usable dataset
  if (fresh.closes && fresh.closes.length >= 60) {
    ohlcvCache[symbol] = { fetchedAt: Date.now(), data: fresh };
  }
  return { ...fresh, _fromCache: false };
}

// ── VCP (Volatility Contraction Pattern) — Minervini base-count detector ──
// Real Minervini-style analysis: scan price history backwards looking for
// "bases" (consolidation periods), count them since last deep correction,
// and assess contraction quality.
//
// A base is a consolidation period where:
//   - duration ≥ 5 trading days
//   - high-low range < 18% of starting price
//   - price stays above its starting low throughout
//   - was preceded by an advance (not a downtrend)
//
// Output:
//   {
//     vcpScore:        0-6  (4 = base 1 ideal; +1/+2 for contraction bonuses)
//     baseNumber:      1-5+ (0 if no clear base)
//     vcpDepth:        current base depth % (back-compat: was vcpDepth)
//     pivotPrice:      highest high in current base (breakout trigger)
//     baseStartDate:   ISO date — null (no timestamps in OHLCV stream)
//     baseStartIdx:    integer index from end (e.g. 12 = base started 12 days ago)
//     baseDays:        length of current base in trading days
//     priorPullbackPct: % drop from peak before current base started
//   }
function calcVCPv2(closes, highs, lows, volumes) {
  const empty = {
    vcpScore: 0, baseNumber: 0, vcpDepth: null,
    pivotPrice: null, baseStartDate: null, baseStartIdx: null,
    baseDays: 0, priorPullbackPct: null,
  };
  const n = closes.length;
  if (!Array.isArray(closes) || n < 60) return empty;
  if (!Array.isArray(highs) || highs.length < n) return empty;
  if (!Array.isArray(lows)  || lows.length  < n) return empty;
  const vols = Array.isArray(volumes) ? volumes : [];

  // Helper: scan window [start, end) and return high/low range.
  const rangeStats = (start, end) => {
    let hi = -Infinity, lo = Infinity;
    for (let i = start; i < end; i++) {
      if (highs[i] > hi) hi = highs[i];
      if (lows[i]  < lo) lo = lows[i];
    }
    return { hi, lo, depthPct: lo > 0 ? (hi - lo) / lo : 0 };
  };
  const avgVol = (start, end) => {
    if (vols.length < end) return 0;
    let sum = 0, cnt = 0;
    for (let i = start; i < end; i++) {
      const v = vols[i];
      if (v != null && isFinite(v)) { sum += v; cnt++; }
    }
    return cnt > 0 ? sum / cnt : 0;
  };

  // ── Step 1: Detect current base (end of series back to consolidation start)
  // Walk back from the latest bar while price stays above (baseLow * 0.95),
  // depth stays < 18%, and we haven't gone more than 60 days back.
  // We allow a 5% undercut tolerance for noisy intraday wicks.
  const MAX_BASE_LEN = 60, MIN_BASE_LEN = 5, MAX_DEPTH = 0.18, UNDERCUT_TOL = 0.05;
  let baseStartIdx = -1;
  let baseHi = highs[n - 1], baseLo = lows[n - 1];
  for (let k = 1; k < Math.min(MAX_BASE_LEN, n); k++) {
    const i = n - 1 - k;
    if (i < 0) break;
    const newHi = Math.max(baseHi, highs[i]);
    const newLo = Math.min(baseLo, lows[i]);
    const depth = newLo > 0 ? (newHi - newLo) / newLo : 0;
    // Stop expanding base if depth exceeds 18% — that's no longer a base
    if (depth > MAX_DEPTH) {
      baseStartIdx = i + 1;
      break;
    }
    // Stop if a deep undercut (>5%) below the base low so far
    if (k >= MIN_BASE_LEN && newLo < baseLo * (1 - UNDERCUT_TOL)) {
      baseStartIdx = i + 1;
      break;
    }
    baseHi = newHi; baseLo = newLo;
    baseStartIdx = i;
  }
  // If we couldn't establish a base of min length, no setup
  const baseDays = (n - 1) - baseStartIdx + 1;
  if (baseStartIdx < 0 || baseDays < MIN_BASE_LEN) return empty;

  const currentBaseDepth = baseLo > 0 ? (baseHi - baseLo) / baseLo : 0;
  const currentBaseVol = avgVol(baseStartIdx, n);

  // ── Step 2: Confirm base preceded by an advance (otherwise it's just a fall)
  // Check if 20-day return into base start was positive (advance into base).
  const preAdvanceLookback = 20;
  const preStart = Math.max(0, baseStartIdx - preAdvanceLookback);
  let priorPullbackPct = null;
  let preAdvanceOk = false;
  if (preStart < baseStartIdx) {
    const preLow = Math.min(...lows.slice(preStart, baseStartIdx));
    const preHigh = Math.max(...highs.slice(preStart, baseStartIdx));
    // Advance check: pre-base high should be at least 10% above pre-base low
    preAdvanceOk = preLow > 0 && (preHigh - preLow) / preLow >= 0.10;
    // Pullback into base: how far did price drop from pre-base peak to base low?
    if (preHigh > 0) {
      priorPullbackPct = ((preHigh - baseLo) / preHigh) * 100;
    }
  }
  if (!preAdvanceOk) return empty;

  // ── Step 3: Count bases backwards since the last deep correction (≥20%)
  // Walk back through prior consolidations, identifying each one until
  // we hit a deep correction (≥20% peak-to-trough drop).
  let baseNumber = 1;
  let scanEnd = baseStartIdx;        // exclusive end of prior region to scan
  const priorBases = [];              // collect for contraction analysis
  const DEEP_CORRECTION_PCT = 20;

  while (baseNumber < 6 && scanEnd > 30) {
    // Find prior peak in the 60 days before scanEnd
    const lookBack = Math.max(0, scanEnd - 60);
    let priorPeak = -Infinity, priorPeakIdx = -1;
    for (let i = lookBack; i < scanEnd; i++) {
      if (highs[i] > priorPeak) { priorPeak = highs[i]; priorPeakIdx = i; }
    }
    if (priorPeakIdx < 0) break;

    // Find pullback low from priorPeak to scanEnd
    let pullbackLow = Infinity, pullbackLowIdx = -1;
    for (let i = priorPeakIdx; i < scanEnd; i++) {
      if (lows[i] < pullbackLow) { pullbackLow = lows[i]; pullbackLowIdx = i; }
    }
    if (pullbackLowIdx < 0) break;

    const pullbackPct = priorPeak > 0 ? ((priorPeak - pullbackLow) / priorPeak) * 100 : 0;
    // If this prior leg was a deep correction (≥20%), stop counting — fresh count
    if (pullbackPct >= DEEP_CORRECTION_PCT) break;

    // Find an earlier base inside [lookBack, priorPeakIdx]:
    // walk forward from lookBack looking for a 5+ day window with depth < 18%
    let foundBaseStart = -1, foundBaseEnd = -1, foundBaseHi = 0, foundBaseLo = 0;
    for (let s = priorPeakIdx - 1; s >= lookBack + MIN_BASE_LEN - 1; s--) {
      let hi = -Infinity, lo = Infinity;
      let valid = true;
      for (let len = 0; len < MAX_BASE_LEN && s - len >= lookBack; len++) {
        const idx = s - len;
        hi = Math.max(hi, highs[idx]);
        lo = Math.min(lo, lows[idx]);
        const d = lo > 0 ? (hi - lo) / lo : 0;
        if (d > MAX_DEPTH) {
          if (len + 1 >= MIN_BASE_LEN) {
            foundBaseStart = idx + 1; foundBaseEnd = s + 1;
            // recompute hi/lo on the included window
            foundBaseHi = -Infinity; foundBaseLo = Infinity;
            for (let i = foundBaseStart; i < foundBaseEnd; i++) {
              if (highs[i] > foundBaseHi) foundBaseHi = highs[i];
              if (lows[i]  < foundBaseLo) foundBaseLo = lows[i];
            }
          }
          valid = false; break;
        }
      }
      if (foundBaseStart >= 0) break;
      // If we walked all the way without exceeding depth, treat s..lookBack as base
      if (valid && s - lookBack + 1 >= MIN_BASE_LEN) {
        foundBaseStart = lookBack; foundBaseEnd = s + 1;
        foundBaseHi = hi; foundBaseLo = lo;
        break;
      }
    }
    if (foundBaseStart < 0) break;

    const priorBaseDepth = foundBaseLo > 0 ? (foundBaseHi - foundBaseLo) / foundBaseLo : 0;
    const priorBaseVol = avgVol(foundBaseStart, foundBaseEnd);
    priorBases.push({
      start: foundBaseStart, end: foundBaseEnd,
      hi: foundBaseHi, lo: foundBaseLo, depth: priorBaseDepth,
      pullbackPct, avgVol: priorBaseVol,
    });
    baseNumber++;
    scanEnd = foundBaseStart;
  }

  // ── Step 4: Score
  // Base 1 = score 4, Base 2 = 3, Base 3 = 2, Base 4+ = 1
  const baseScores = { 1: 4, 2: 3, 3: 2, 4: 1, 5: 1 };
  let score = baseScores[baseNumber] || 1;

  // Bonus: current pullback < prior pullback (proper contraction)
  const prevBase = priorBases[0];
  if (prevBase && priorPullbackPct != null && prevBase.pullbackPct > 0
      && priorPullbackPct < prevBase.pullbackPct) {
    score++;
  }
  // Bonus: current base avg volume < prior base avg volume (drying up)
  if (prevBase && prevBase.avgVol > 0 && currentBaseVol > 0
      && currentBaseVol < prevBase.avgVol) {
    score++;
  }
  score = Math.max(0, Math.min(6, score));

  return {
    vcpScore: score,
    baseNumber,
    vcpDepth: Math.round(currentBaseDepth * 100),
    pivotPrice: +baseHi.toFixed(2),
    baseStartDate: null,
    baseStartIdx: (n - 1) - baseStartIdx,  // days back from latest bar
    baseDays,
    priorPullbackPct: priorPullbackPct != null ? +priorPullbackPct.toFixed(1) : null,
  };
}

// Backward-compatible wrapper — older callers expect calcVCP(closes, highs, lows)
function calcVCP(closes, highs, lows, volumes) {
  return calcVCPv2(closes, highs, lows, volumes);
}

// ── Sector / industry → ETF mapping (Yahoo assetProfile) ───────────────────
// INDUSTRY first (more specific), SECTOR as fallback. Both Yahoo strings are
// long-form English (e.g. "Semiconductors", "Software—Application").
const SECTOR_TO_ETF = {
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
};

// Industry strings as Yahoo returns them — note: em-dash separator on Software
const INDUSTRY_TO_ETF = {
  // Semiconductors family
  'Semiconductors':                          'SMH',
  'Semiconductor Equipment & Materials':     'SMH',
  // Software family
  'Software—Application':                    'IGV',
  'Software—Infrastructure':                 'IGV',
  'Software - Application':                  'IGV',
  'Software - Infrastructure':               'IGV',
  // Biotech
  'Biotechnology':                           'IBB',
  'Drug Manufacturers—Specialty & Generic':  'IBB',
  // Defense / aerospace
  'Aerospace & Defense':                     'XAR',
  // Precious metals / mining
  'Gold':                                    'GDX',
  'Silver':                                  'GDX',
  'Other Precious Metals & Mining':          'GDX',
  // Solar / clean energy
  'Solar':                                   'TAN',
  // Real estate sub-industries default to XLRE via SECTOR_TO_ETF
};

async function getSectorInfo(symbol) {
  const url = withCrumb(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=assetProfile,summaryProfile`);
  const data = await yfFetch(url);
  const profile = data?.quoteSummary?.result?.[0]?.assetProfile
               || data?.quoteSummary?.result?.[0]?.summaryProfile;
  return {
    sector:   profile?.sector   || null,
    industry: profile?.industry || null,
  };
}

// Resolve sector/industry → ETF using industry-first, sector-fallback strategy.
function resolveSectorEtf(sector, industry) {
  if (industry && INDUSTRY_TO_ETF[industry]) return INDUSTRY_TO_ETF[industry];
  if (sector   && SECTOR_TO_ETF[sector])     return SECTOR_TO_ETF[sector];
  return null;
}

// Look up a symbol's sector ETF with 1-year cache. Returns { sector, industry, etf }.
// `cache` is mutated in place; caller persists at scan end.
async function lookupSectorWithCache(symbol, cache) {
  const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const hit = cache[symbol];
  if (hit && hit.cachedAt && (now - hit.cachedAt) < ONE_YEAR_MS) {
    return { sector: hit.sector, industry: hit.industry, etf: hit.etf };
  }
  try {
    const { sector, industry } = await getSectorInfo(symbol);
    const etf = resolveSectorEtf(sector, industry);
    cache[symbol] = { sector, industry, etf, cachedAt: now };
    return { sector, industry, etf };
  } catch (e) {
    // Negative cache for 1 day so we don't hammer Yahoo on broken tickers.
    cache[symbol] = { sector: null, industry: null, etf: null, cachedAt: now - ONE_YEAR_MS + 24 * 60 * 60 * 1000 };
    return { sector: null, industry: null, etf: null };
  }
}

// ── Quote summary (earnings, short, analyst) with 24h cache ────────────────
// Single endpoint returns 5 modules. Used only for tickers that PASS the leader
// or discovery filter — otherwise we'd hit Yahoo for the entire universe.
async function getQuoteSummary(symbol) {
  const modules = 'calendarEvents,defaultKeyStatistics,upgradeDowngradeHistory,recommendationTrend,earningsHistory';
  const url = withCrumb(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`);
  const data = await yfFetch(url);
  return data?.quoteSummary?.result?.[0] || null;
}

// Pull out the small set of fields we care about. Be defensive — many small
// caps have no analyst coverage, no short interest, etc. Optional chaining
// everywhere; never throw on missing fields.
function extractQuoteFields(summary) {
  if (!summary) return null;

  // ── Earnings date / days-to-earnings ──
  const earningsDates = summary.calendarEvents?.earnings?.earningsDate;
  const earningsRaw = Array.isArray(earningsDates) && earningsDates.length > 0
    ? (earningsDates[0]?.raw ?? earningsDates[0])
    : null;
  const earningsDate = (typeof earningsRaw === 'number' && earningsRaw > 0) ? earningsRaw : null;
  const daysToEarnings = (earningsDate != null)
    ? Math.round((earningsDate * 1000 - Date.now()) / (24 * 60 * 60 * 1000))
    : null;

  // ── Short interest ──
  const keyStats = summary.defaultKeyStatistics || {};
  const shortPctOfFloat = keyStats.shortPercentOfFloat?.raw ?? keyStats.shortPercentOfFloat ?? null;
  const shortRatio      = keyStats.shortRatio?.raw         ?? keyStats.shortRatio         ?? null;

  // ── Upgrades / downgrades in past 30 days ──
  const history = summary.upgradeDowngradeHistory?.history || [];
  const cutoffSec = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
  const recentUpgrades = [];
  const recentDowngrades = [];
  for (const entry of history) {
    const epoch = entry.epochGradeDate?.raw ?? entry.epochGradeDate ?? 0;
    if (epoch < cutoffSec) continue;
    const action = (entry.action || '').toLowerCase();
    const item = {
      firm:     entry.firm     || null,
      action:   entry.action   || null,
      toGrade:  entry.toGrade  || null,
      fromGrade: entry.fromGrade || null,
      date:     epoch || null,
    };
    if (action === 'up'   && recentUpgrades.length   < 3) recentUpgrades.push(item);
    if (action === 'down' && recentDowngrades.length < 3) recentDowngrades.push(item);
  }

  // ── Earnings surprise history (last 4 quarters) ──
  const earningsHist = summary.earningsHistory?.history || [];
  const surpriseHistory = earningsHist.slice(-4).map(q => ({
    qtr:         q.quarter?.fmt || q.period || null,
    actual:      q.epsActual?.raw   ?? q.epsActual   ?? null,
    estimate:    q.epsEstimate?.raw ?? q.epsEstimate ?? null,
    surprisePct: q.surprisePercent?.raw ?? q.surprisePercent ?? null,
  }));

  // ── Recommendation trend (latest) ──
  const trend = summary.recommendationTrend?.trend?.[0];
  const recommendation = trend ? {
    strongBuy:  trend.strongBuy  ?? null,
    buy:        trend.buy        ?? null,
    hold:       trend.hold       ?? null,
    sell:       trend.sell       ?? null,
    strongSell: trend.strongSell ?? null,
  } : null;

  return {
    earningsDate, daysToEarnings,
    shortPctOfFloat, shortRatio,
    recentUpgrades, recentDowngrades,
    surpriseHistory, recommendation,
  };
}

// Cached fetch of quote summary fields. `cache` mutated in place.
async function lookupQuoteWithCache(symbol, cache) {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const hit = cache[symbol];
  if (hit && hit.cachedAt && (now - hit.cachedAt) < ONE_DAY_MS) {
    return hit.data || null;
  }
  try {
    const summary = await getQuoteSummary(symbol);
    const data = extractQuoteFields(summary);
    cache[symbol] = { data, cachedAt: now };
    return data;
  } catch (e) {
    // Negative-cache for 6h to avoid hammering broken tickers
    cache[symbol] = { data: null, cachedAt: now - ONE_DAY_MS + 6 * 60 * 60 * 1000 };
    return null;
  }
}

async function fetchScreener(scrId, count = 50) {
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${scrId}&start=0&count=${count}&formatted=false`;
    const data = await yfFetchPlain(url);
    const quotes = data?.finance?.result?.[0]?.quotes || [];
    return quotes.map(q => q.symbol).filter(s => s && s.length <= 5 && !/[./]/.test(s));
  } catch (e) {
    console.warn(`  Screener ${scrId} failed: ${e.message}`);
    return [];
  }
}

// ── Stock universe ──────────────────────────────────────────────────────────

const SP500 = [
  // Information Technology
  'AAPL','MSFT','NVDA','AVGO','ORCL','CRM','AMD','QCOM','TXN','INTC',
  'MU','AMAT','LRCX','KLAC','ADI','MRVL','CDNS','SNPS','ANSS','FTNT',
  'PANW','CRWD','ZS','OKTA','DDOG','NET','MDB','SNOW','NOW','WDAY',
  'ADBE','INTU','MSCI','EPAM','CTSH','ACN','IBM','HPQ','HPE','DELL',
  'SMCI','GLW','TEL','APH','TDY','KEYS','TRMB','FFIV','JNPR','NTAP',
  // Communication Services
  'META','GOOGL','GOOG','NFLX','DIS','CMCSA','T','VZ','TMUS','CHTR',
  'TTWO','EA','WBD','PARA','LYV','OMC','IPG','FOXA','FOX',
  // Consumer Discretionary
  'AMZN','TSLA','HD','MCD','NKE','SBUX','TJX','LOW','BKNG','MAR',
  'HLT','ABNB','RCL','CCL','NCLH','YUM','CMG','DRI','QSR','WYNN',
  'LVS','MGM','EXPE','UBER','ETSY','EBAY','RL','PVH','TPR','AZO',
  'ORLY','KMX','GPC','POOL','NVR','PHM','DHI','LEN','TOL',
  // Consumer Staples
  'WMT','COST','PG','KO','PEP','PM','MO','MDLZ','CL','GIS',
  'K','CPB','HRL','CAG','MKC','KHC','STZ','EL','CHD','CLX','KMB',
  // Health Care
  'LLY','JNJ','UNH','ABBV','MRK','TMO','ABT','DHR','BMY','AMGN',
  'GILD','VRTX','REGN','ISRG','BSX','MDT','EW','SYK','ZBH','BAX',
  'BDX','HOLX','IDXX','IQV','DXCM','ALGN','EXAS','MRNA','PFE',
  'CVS','CI','HUM','ELV','CNC','MOH','HCA','THC','UHS',
  // Financials
  'JPM','BAC','WFC','GS','MS','C','AXP','BLK','SCHW','COF',
  'DFS','SYF','MET','PRU','AFL','ALL','TRV','CB','AJG','MMC',
  'AON','BX','KKR','APO','CG','ARES','V','MA','PYPL','FI',
  'FIS','GPN','FISV','USB','PNC','TFC','FITB','RF','HBAN','KEY',
  'MTB','NTRS','STT','ALLY','SLM',
  // Energy
  'XOM','CVX','COP','EOG','DVN','MPC','VLO','PSX','HES','OXY',
  'SLB','HAL','BKR','CTRA','APA','MRO','SM','MTDR','VTLE','MGY',
  // Industrials
  'CAT','DE','HON','GE','RTX','LMT','NOC','GD','BA','TDG',
  'HWM','HII','LDOS','SAIC','CSX','UNP','NSC','UPS','FDX','XPO',
  'ODFL','SAIA','JBHT','CHRW','EXPD','MMM','EMR','ETN','ROK','PH',
  'AME','FAST','GWW','CARR','OTIS','TT','JCI','AOS','IR','XYL','GNRC',
  // Materials
  'LIN','APD','ECL','PPG','SHW','FCX','NEM','GOLD','AA','NUE',
  'STLD','CF','MOS','ALB',
  // Real Estate
  'AMT','PLD','EQIX','CCI','SBAC','DLR','PSA','EQR','AVB','O','VICI',
  // Utilities
  'NEE','DUK','SO','AEP','EXC','SRE','XEL','D','ETR','WEC','DTE',
].filter((v, i, a) => a.indexOf(v) === i);

// Confirmed momentum + growth names beyond S&P 500
const GROWTH_EXTENDED = [
  // AI infrastructure & chips
  'PLTR','ARM','CRDO','ALAB','NVDA','SMCI',
  // Quantum computing
  'IONQ','RGTI','QBTS','ARQQ',
  // Space & defense tech
  'RKLB','ASTS','LUNR','RDW','BKSY','PL',
  // Crypto / digital assets
  'COIN','MSTR','MARA','RIOT','HUT','CIFR','CLSK',
  // AI software & SaaS
  'AXON','DUOL','GTLB','DDOG','NET','SNOW','MDB','BRZE','AMPL',
  'DOCN','ESTC','APPN','PEGA','BOX','FSLY',
  // Fintech
  'HOOD','AFRM','UPST','SOFI','NU','GLBE','SEMR',
  // Biotech / healthtech
  'HIMS','RXRX','DOCS','EXAS','ACCD','NVCR',
  'TMDX','IRTC','INSP','SILK','ATRC','SWAV','NARI',
  'BEAM','CRSP','EDIT','NTLA','VERV','FOLD','IMCR',
  // EV / autonomous
  'ACHR','JOBY','OUST','LAZR',
  // Emerging growth
  'MELI','PDD','SE','TSM','ASML','LSCC','WOLF',
  'CELH','DKNG','RBLX',
  // Energy transition
  'FLNC','NRGV','GPRE','LASR',
];

// Russell-style mid/small cap extension — adds breadth across all sectors so the
// universe can comfortably exceed 1500 unique tickers (plan acceptance target).
// Curated from common Russell 1000/2000 components + popular themes; ETFs filtered
// by isEtf() at the universe build step.
const RUSSELL_EXTENDED = [
  // ── Tech (mid/small cap) ───────────────────────────────────────────────
  'TSEM','CRUS','SLAB','MPWR','SWKS','MCHP','ON','POWI','SITM','MTSI',
  'AAOI','LITE','COHR','CIEN','INFN','VIAV','CALX','EXTR','NTGR','NETI',
  'AUDC','CSCO','ANET','HPQ','PSTG','NTAP','WDC','STX','SNDK','SMART',
  'SANM','BHE','FLEX','JBL','CLS','PLXS','TTMI','VSAT','VIAV','OSIS',
  'POWL','BMI','WDC','SMCI','HPE','DELL','HPQ','LOGI','ZBRA','ROP',
  'TYL','PTC','ANSS','MANH','PRGS','GWRE','SPSC','NTNX','RBLX','DASH',
  'TWLO','ZM','RNG','FIVN','CFLT','PD','WIX','SHOP','SQSP','GDDY',
  'BKNG','CHWY','OPCH','GLBE','SE','MELI','PDD','BABA','JD','NTES',
  'BIDU','TME','BILI','VIPS','HUYA','DOYU','EH','XPEV','NIO','LI',
  'ZK','XPEV','RIVN','LCID','FFIE','GOEV','NKLA','MULN','HYZN','PSNY',
  'MMYT','TOUR','TRIP','EXPE','ABNB','UBER','LYFT','DASH','GRAB','BIRD',
  'PLNT','VFC','UAA','UA','LULU','RL','PVH','TPR','CPRI','CRI',
  // ── Healthcare/Biotech mid/small cap ──────────────────────────────────
  'IRTC','NVRO','SILK','ATRC','SWAV','NARI','PEN','SHC','TMDX','INSP',
  'NVCR','PACS','LBPH','MIRA','SAVA','AXSM','VYNE','VRDN','CRNX','CTLT',
  'LEGN','PCVX','RVMD','ITCI','MGNX','XBI','XPH','LABU','LABD',
  'SRPT','ARWR','IONS','ALNY','BMRN','UTHR','EXEL','INCY','VRTX','REGN',
  'BIIB','MRNA','BNTX','NVAX','OCGN','VBIV','IDYA','ATAI','CMPS','MNMD',
  'HUMA','LFMD','HIMS','TDOC','AMWL','LMND','EHTH','HQY','EVH','OPK',
  'PRTA','CCXI','RYTM','VKTX','VRNA','ANIK','CRMD','HRMY','PHAT','XENE',
  'KRTX','IBRX','RNA','FOLD','IMCR','MEDP','IQV','CRL','RGEN','ICLR',
  // ── Financials (mid/small cap, fintech, regional banks) ───────────────
  'HOOD','SOFI','LC','UPST','AFRM','PYPL','SQ','ALLY','SYF','DFS',
  'NU','BBAR','BMA','PAGS','STNE','XYF','HMHC','GLBE','CWAN','TOST',
  'BILL','MQ','ML','OPRT','MGI','EVRI','SNEX','LPLA','VRTS','ARES',
  'BAM','BX','KKR','APO','BLK','TROW','BEN','LM','IVZ','AMG',
  'CG','OWL','GLOB','MITT','MFA','NLY','AGNC','PFC','PRT','TWO',
  'MTG','RDN','TYBT','CACC','SLM','SOFI','NAVI','NMR','MS','SF',
  'JEF','RJF','MS','VIRT','CME','ICE','NDAQ','CBOE','MKTX','TW',
  // ── Industrials/Defense (mid/small cap) ──────────────────────────────
  'GD','LMT','RTX','BA','NOC','LHX','TDG','HEI','HII','TXT',
  'ATI','HWM','BWXT','CW','MOG','WWD','POWL','VMI','MWA','VLTO',
  'ENS','GTLS','CHX','FTV','EME','PWR','PRIM','MTZ','GVA','STRL',
  'NVT','HUBB','AYI','LFUS','REZI','TT','CARR','OTIS','JCI','JBT',
  'LECO','IEX','XYL','GGG','NDSN','SPX','WTS','AOS','RBC','BCO',
  'WTRG','AWR','SJW','CWT','MSEX','SBS','PNR','BMI','BAH','LDOS',
  'CACI','SAIC','MAXR','PSN','VVX','TGI','AIR','AAON','MTW','TEX',
  // ── Energy (mid/small cap) ────────────────────────────────────────────
  'RIG','NE','VAL','TDW','HP','PTEN','NBR','LBRT','PUMP','RES',
  'WHD','CHRD','PR','CRGY','MGY','GPOR','SBOW','VTLE','REPX','BTU',
  'AR','SWN','RRC','EQT','CTRA','MTDR','SM','APA','MUR','CHRD',
  'PBR','PBRA','XEC','OAS','BCEI','BRY','CRC','DEN','EGY','ESTE',
  'CHK','OVV','MPC','VLO','PSX','HFC','DK','TRGP','ENB','ET',
  'EPD','MMP','MPLX','OKE','WMB','KMI','PAA','PAGP','SUN','USAC',
  // ── Materials/Mining ──────────────────────────────────────────────────
  'CLF','X','MT','RS','STLD','NUE','CMC','WOR','TKR','CRS',
  'AA','CENX','KALU','HAYN','ATI','PKX','SCCO','TECK','VALE','BHP',
  'RIO','WPM','PAAS','AG','HL','EXK','SVM','MUX','GATO','NEM',
  'AEM','GOLD','FNV','SAND','OR','RGLD','KGC','BTG','EGO','AU',
  'NGD','OGN','SBSW','MP','UEC','URG','URA','LEU','UUUU','DNN',
  'CCJ','NXE','LTBR','ASPN','MAGN','SMR','OKLO','NNE','BWXT','VST',
  // ── Consumer Discretionary (mid/small) ────────────────────────────────
  'DKS','HIBB','BOOT','GES','BURL','ROST','ULTA','SBH','SIG','TJX',
  'BBY','GME','BBWI','VSCO','AEO','URBN','ZUMZ','EXPR','CATO','TLYS',
  'KMX','CVNA','AN','ABG','GPI','LAD','PAG','SAH','RUSHA','RUSHB',
  'CWH','LCII','THO','WGO','PII','BRP','MBUU','HZO','MCFT','LCII',
  'YETI','VFC','HBI','OXM','CRI','GIII','PLBY','MOV','FOSL','HBI',
  'GPS','LEVI','ANF','GIL','UAA','UA','LULU','PVH','RL','TPR',
  'WSM','RH','LZB','FND','HVT','MLHR','LEG','TPX','SNBR','PRPL',
  // ── Consumer Staples (mid/small) ──────────────────────────────────────
  'POST','THS','LANC','BGS','UTZ','SMPL','SIMPS','HAIN','TWNK','FLO',
  'CALM','VITL','VFF','SAM','TAP','BUD','DEO','STZ',
  'KO','PEP','MNST','CELH','FIZZ','PRMW','COKE','KDP','TPB','TPCA',
  // ── Real Estate (mid/small REITs) ────────────────────────────────────
  'O','SPG','REG','FRT','KIM','BRX','MAC','NNN','EPRT','ADC',
  'STAG','PLD','EXR','LSI','CUBE','PSA','NSA','UHAL','REXR','EGP',
  'PEAK','VTR','WELL','OHI','CTRE','SBRA','NHI','LTC','BFS','UMH',
  'INVH','SUI','ELS','AMH','MAA','CPT','EQR','AVB','UDR','ESS',
  'HST','PEB','RHP','RLJ','SHO','APLE','XHR','BHR','DRH','SVC',
  'SLG','VNO','BXP','HIW','KRC','PDM','BDN','HPP','CUZ','ARE',
  'AMT','CCI','SBAC','DLR','EQIX','IRM','SRC','EXR','VICI','GLPI',
  // ── Utilities ─────────────────────────────────────────────────────────
  'NEE','SO','DUK','AEP','D','EXC','SRE','XEL','WEC','ED',
  'EIX','PCG','PEG','ETR','ES','FE','CMS','DTE','LNT','AEE',
  'EVRG','AWK','PNW','NRG','VST','OGE','NJR','POR','BKH','IDA',
  // ── Other small caps & themes (clean energy, growth) ──────────────────
  'ENPH','SEDG','FSLR','RUN','ARRY','SHLS','SPWR','NOVA','MAXN','SOL',
  'BE','PLUG','BLDP','FCEL','BLNK','CHPT','EVGO','WBX','TPIC','FREY',
  'QS','LCID','RIVN','FFIE','XPEV','NIO','LI','LAZR','OUST','VLD',
  'INVZ','MVST','MITK','PSFE','AEYE','VLN','UMC','HIMX','OSPN','VRA',
  'CAMP','TRIP','GOLF','EAT','BJRI','CAKE','TXRH','PLAY','PZZA','DENN',
  'WEN','JACK','SHAK','WING','CMG','BROS','PTLO','GO','SG','CAVA',
  'BIRD','UPWK','FVRR','ANGI','TRUP','RVLV','MNRO','LOVE','OLPX','BIRK',
  'BFLY','VYGR','RXST','ITOS','TRDA','RYTM','TLSI','AGEN','AKBA','ALEC',
  'ASND','AMRX','ALPN','ANNX','APLD','BBIO','BMEA','CABA','CARM','CCCC',
  'CDMO','CDXS','CGEM','CGTX','CHRS','CMPO','CMRX','CMTL','CMPX','CNTA',
  'COGT','CPRX','CRDF','CRMD','CTKB','CTMX','CYTK','DAWN','DCTH','DNLI',
  'DRRX','DSP','DVAX','DYN','EDIT','ELAN','ELOX','ELYM','ENTA','ESPR',
  'ETON','EVLO','EYE','FBIO','FENC','GDYN','GERN','GLPG','GMAB','GRTX',
  'GTHX','HALO','HOLX','HRTX','HTBX','ICVX','IDYA','IMMR','INMB','INDV',
  'INVA','IONS','IPHA','IRMD','IRWD','JANX','KALA','KIDS','KOD','KPTI',
  'KROS','KRYS','KURA','LFST','LGND','LIAN','LIN','LMNL','LPCN','LQDA',
  'LRMR','LYEL','MGNX','MIST','MLAB','MNKD','MNOV','MRSN','MRVI','MYO',
  'NBTX','NGNE','NKTR','NRIX','NTLA','NUVB','NVAX','NVCT','NVST','NVTA',
  'OCUL','OCX','OMER','OMI','ONCY','OPRX','OPRT','ORIC','OSCR','PCRX',
  'PDSB','PHAR','PHIO','PLRX','PMVP','PRTH','PTCT','PTGX','PYXS','RCEL',
  'RCKT','RCUS','RDUS','RGNX','RGS','RIGL','RLAY','RLMD','RNAZ','RPRX',
  'RVPH','RWLK','RYTM','SAGE','SBET','SCPH','SCYX','SDGR','SEEL','SENS',
  'SGRY','SHCR','SIBN','SIGA','SLNO','SLP','SMMT','SNDX','SNGX','SNSE',
  'SONN','SPRO','SPRY','SQNS','SRRA','SRTS','SRTY','STIM','STOK','SUPN',
  'SVMK','SWTX','TARS','TBPH','TCDA','TCMD','TECH','TELA','TGTX','THRX',
  'TLIS','TMCI','TNGX','TPST','TRDA','TRVI','TSHA','TVTX','TYRA','UEC',
  'UPLD','URGN','UTMD','VAPO','VBLT','VCEL','VECT','VERA','VERV','VG',
  'VINP','VIVK','VKTX','VOR','VRDN','VRPX','VSTM','VTAK','VTGN','VTRS',
  'VTYX','VVOS','WAVS','WBA','WTM','WVE','XBIT','XENE','XERS','XFOR',
  'XGN','XOMA','XRX','YMAB','YRCW','ZCMD','ZIM','ZIVO','ZLAB','ZNTL',
];

// Early-stage / acceleration discovery pool — AI era emerging names
// Shorter-history stocks, recent IPOs, sector inflection plays
const DISCOVERY_POOL = [
  // AI agents & infrastructure
  'SOUN','BBAI','IREN','CORZ','WULF','BTBT','RIOT','MARA',
  'AI','AIXI','AISP','AITX',
  // Robotics & automation
  'NVTS','VNET','AMBA','CEVA','XPERI',
  // Semiconductor equipment & materials
  'ACLS','PLAB','DIOD','ALGM','LSCC','FORM','ONTO','UCTT','KLIC',
  // Defense AI
  'KTOS','RCAT','AVAV','HII','LDOS',
  // Nuclear / energy AI
  'SMR','OKLO','NNE','LEU','UUUU','CCJ',
  // Biotech acceleration
  'RXRX','STTK','MBX','IBRX','IMVT','KRTX',
  // Satellite & connectivity
  'ASTS','RKLB','PL','BKSY','LLAP',
  // Financial AI
  'AFRM','UPST','DAVE','OPFI',
  // Industrial AI
  'FLNC','NRGV','OUST','RBOT',
  // Consumer AI
  'DUOL','HIMS','DOCS',
  // Misc emerging
  'MSTR','CIFR','HUT','CLSK','WULF','CORZ',
  'LASR','GLW','STX','WDC','SNDK',
].filter((v, i, a) => a.indexOf(v) === i);

// TW scan pool
const TW_POOL = [
  '2330.TW','2317.TW','2454.TW','2382.TW','2308.TW','2303.TW','2412.TW',
  '2881.TW','2882.TW','2884.TW','2885.TW','2886.TW','2887.TW','2888.TW',
  '2891.TW','2892.TW','2301.TW','2302.TW','2311.TW','2313.TW',
  '2324.TW','2325.TW','2327.TW','2328.TW','2337.TW','2338.TW','2340.TW',
  '2344.TW','2347.TW','2352.TW','2353.TW','2354.TW','2355.TW','2356.TW',
  '2357.TW','2359.TW','2360.TW','2362.TW','2363.TW','2364.TW','2365.TW',
  '2367.TW','2369.TW','2371.TW','2374.TW','2375.TW','2376.TW','2377.TW',
  '2379.TW','2383.TW','2385.TW','2387.TW','2388.TW','2392.TW','2393.TW',
  '2395.TW','2397.TW','2399.TW','2401.TW','2404.TW','2406.TW','2408.TW',
  '2409.TW','2413.TW','2414.TW','2415.TW','2417.TW','2420.TW','2421.TW',
  '2423.TW','2424.TW','2425.TW','2426.TW','2427.TW','2428.TW','2429.TW',
  '6505.TW','6669.TW','6770.TW','3008.TW','3034.TW','3035.TW','3036.TW',
  '3037.TW','3038.TW','3041.TW','3042.TW','3044.TW','3045.TW','3046.TW',
  '3047.TW','3048.TW','3049.TW','3050.TW','3051.TW','3052.TW','3053.TW',
  '3054.TW','3055.TW','0050.TW','0056.TW','2002.TW','1301.TW','1303.TW',
];

const ETF_EXCLUDE = new Set([
  'SPY','QQQ','IWM','DIA','VTI','VOO','VEA','VWO','EFA','EEM',
  'GLD','SLV','USO','XLK','XLF','XLV','XLE','XLI','XLY','XLP',
  'ARKK','ARKG','ARKF','TQQQ','SQQQ','UPRO','UVXY','VXX',
  'TLT','IEF','SHY','AGG','BND','LQD','HYG','JNK',
  'MTUM','XMMO','DWAS','QMOM','VFMO','SPHQ','QUAL',
]);

function isEtf(sym) {
  return ETF_EXCLUDE.has(sym) || (/^(PRO|SHO|ULT|SCR)/i.test(sym) && sym.length >= 4);
}

// ── RS Rating ───────────────────────────────────────────────────────────────

function calcRSRatings(stocks) {
  const values = stocks.map(s => s.rs12_1);
  values.sort((a, b) => a - b);
  stocks.forEach(s => {
    const rank = values.filter(v => v <= s.rs12_1).length;
    s.rsRating = Math.round((rank / values.length) * 98) + 1;
  });
}

// ── Core stock metrics from OHLCV data ─────────────────────────────────────

function calcMetrics(closes, highs, volumes, meta, benchReturn) {
  const n = closes.length;
  const price = meta.regularMarketPrice || closes[n - 1];
  const ma50  = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
  const avgVol20 = volumes.slice(-20).reduce((a, b) => a + (b || 0), 0) / 20;
  const avgVol40 = volumes.slice(-40).reduce((a, b) => a + (b || 0), 0) / 40;
  const avgVol5  = volumes.slice(-5).reduce((a,  b) => a + (b || 0), 0) / 5;

  // Momentum at multiple lookbacks
  const idx1m  = Math.max(0, n - 21);
  const idx3m  = Math.max(0, n - 63);
  const idx6m  = Math.max(0, n - 126);

  const ret1m  = (price - closes[idx1m])  / closes[idx1m]  * 100;
  const ret3m  = closes.length > 63  ? (price - closes[idx3m])  / closes[idx3m]  * 100 : null;
  const ret6m  = closes.length > 126 ? (price - closes[idx6m])  / closes[idx6m]  * 100 : null;
  const ret12_1 = (closes[idx1m] - closes[0]) / closes[0] * 100; // 12-1mo (skip last month)

  // Acceleration: compare recent monthly pace vs 3-month monthly avg
  // accel > 1.2 → accelerating; accel < 0.8 → decelerating
  // Guard: require |ret3m| >= 3 to avoid division-near-zero blowup (e.g. flat-then-pop stocks)
  // Cap: clamp to [-3, 5] so one wild month can't produce accel=21
  const accel = (ret3m != null && Math.abs(ret3m) >= 3)
    ? Math.min(5, Math.max(-3, ret1m / (ret3m / 3)))
    : null;

  // Volume expansion
  const volExpand  = avgVol20 > 0 ? avgVol5  / avgVol20 : 1;
  const volTrend   = avgVol40 > 0 ? avgVol20 / avgVol40 : 1; // is recent volume growing?

  const changePct = n >= 2 ? (price - closes[n - 2]) / closes[n - 2] * 100 : 0;
  const high52w   = highs.length > 0 ? Math.max(...highs) : null;
  const high3m    = highs.length > 63 ? Math.max(...highs.slice(-63)) : (highs.length > 0 ? Math.max(...highs) : null);

  return {
    price, ma50, avgVol20, avgVol5,
    ret1m, ret3m, ret6m, ret12_1,
    rs12_1: ret12_1 - benchReturn,
    accel, volExpand, volTrend,
    changePct, high52w, high3m,
  };
}

function round2(v) { return v != null ? Math.round(v * 100) / 100 : null; }

// ── Triple-Resonance Radar ─────────────────────────────────────────────────
// THE killer signal: stocks that simultaneously satisfy ≥3 of these predictive
// conditions are statistically the highest-probability setups before a move:
//   1. Earnings catalyst imminent (≤14 days)         — known timing for vol
//   2. VCP tight base (score ≥ 2)                    — Minervini-style setup
//   3. Insider cluster buy OR ≥2 analyst upgrades    — informed-money signal
//   4. RS Rating ≥ 80                                — already leading market
//   bonus: news sentiment 'bullish'                  — narrative tailwind
//
// Returns the top 15 candidates sorted by stars desc, then composite desc.
// Each candidate is a flat object with reasons[] (zh-TW) for UI display.
function computeTripleResonance(leaders, discoveries, insiderData, newsSentiment) {
  const all = [...leaders, ...discoveries];
  const seen = new Set();
  const candidates = [];

  for (const stock of all) {
    if (seen.has(stock.symbol)) continue;
    seen.add(stock.symbol);

    let stars = 0;
    const reasons = [];

    // Criterion 1: Earnings imminent (≤14 days)
    if (stock.daysToEarnings != null && stock.daysToEarnings >= 1 && stock.daysToEarnings <= 14) {
      stars++;
      reasons.push(`財報倒數 ${stock.daysToEarnings} 天`);
    }

    // Criterion 2: VCP tight base (score ≥ 2)
    if ((stock.vcpScore || 0) >= 2) {
      const depthStr = stock.vcpDepth != null ? ` (${stock.vcpDepth}% base)` : '';
      const baseStr  = stock.vcpBaseNumber ? ` · Base ${stock.vcpBaseNumber}` : '';
      stars++;
      reasons.push(`VCP ${stock.vcpScore}/6${depthStr}${baseStr}`);
    }

    // Criterion 3: Insider cluster buying OR analyst upgrades
    const insider = insiderData && insiderData.bySymbol && insiderData.bySymbol[stock.symbol];
    const hasInsiderBuy = insider && insider.clusterBuy;
    const upgradeCount  = (stock.recentUpgrades || []).length;
    const hasUpgrades   = upgradeCount >= 2;
    if (hasInsiderBuy || hasUpgrades) {
      stars++;
      if (hasInsiderBuy) {
        const k = Math.round((insider.totalValue30d || 0) / 1000);
        reasons.push(`內部人買入 $${k}K (${insider.buyerCount30d || 0} 位)`);
      } else {
        reasons.push(`${upgradeCount} 位分析師升評`);
      }
    }

    // Criterion 4: RS Rating ≥ 80
    if ((stock.rsRating || 0) >= 80) {
      stars++;
      reasons.push(`RS Rating ${stock.rsRating}`);
    }

    // Bonus: news sentiment is bullish
    const news = newsSentiment && newsSentiment.bySymbol && newsSentiment.bySymbol[stock.symbol];
    if (news && news.sentiment === 'bullish') {
      stars++;
      reasons.push('近期新聞偏多');
    }

    if (stars >= 3) {
      candidates.push({
        symbol:             stock.symbol,
        name:               stock.name,
        price:              stock.price,
        rsRating:           stock.rsRating ?? null,
        compositeScore:     stock.compositeScore ?? null,
        daysToEarnings:     stock.daysToEarnings ?? null,
        vcpScore:           stock.vcpScore || 0,
        vcpDepth:           stock.vcpDepth ?? null,
        vcpBaseNumber:      stock.vcpBaseNumber ?? 0,
        vcpPivot:           stock.vcpPivot ?? null,
        insiderValue30d:    insider?.totalValue30d || 0,
        insiderBuyerCount:  insider?.buyerCount30d || 0,
        insiderClusterBuy:  !!insider?.clusterBuy,
        recentUpgradeCount: upgradeCount,
        newsSentiment:      news?.sentiment || null,
        isDiscovery:        !!stock.isDiscovery,
        stars,
        reasons,
      });
    }
  }

  candidates.sort((a, b) => (b.stars - a.stars) || ((b.compositeScore || 0) - (a.compositeScore || 0)));
  return candidates.slice(0, 15);
}

// ── US Scan ─────────────────────────────────────────────────────────────────

async function scanUS() {
  console.log('\n=== US RS Leader + Discovery Scan ===');
  console.log(`Start: ${new Date().toISOString()}`);

  // 0. Initialize Yahoo session (cookie + crumb) — required for quoteSummary v10
  await yfInitSession();

  // 1. Build universe
  console.log('\n[1] Building universe...');

  // Yahoo predefined screeners — broader coverage. Some may 404; fetchScreener returns [] on failure.
  const SCREENER_IDS = [
    'day_gainers',
    'small_cap_gainers',
    'growth_technology_stocks',
    'most_actives',
    'undervalued_growth_stocks',
    'aggressive_small_caps',
    'undervalued_large_caps',
  ];

  const screenerResults = await Promise.allSettled(
    SCREENER_IDS.map(id => fetchScreener(id, 75))
  );

  // 2026-05-16 (round 2): RUSSELL_EXTENDED restored.
  // Original slowness was actually the cookie-bearing yfFetch corrupting the chart
  // endpoint responses (returned 200 OK + empty data, masquerading as slow).
  // With the plain fetcher now in use for chart, even 1500-ticker scans finish
  // in 3-5 min cold start and ~1-2 min warm (OHLCV cache hits).
  const universe = new Set([...SP500, ...GROWTH_EXTENDED, ...DISCOVERY_POOL, ...RUSSELL_EXTENDED]);
  // Track which screener(s) surfaced each ticker so we can save to memory below.
  const todaySources = new Map(); // ticker → Set<screenerId>
  const todayISO = new Date().toISOString().slice(0, 10);

  screenerResults.forEach((r, idx) => {
    const id = SCREENER_IDS[idx];
    if (r.status === 'fulfilled') {
      const syms = r.value.filter(s => !isEtf(s));
      console.log(`  screener[${id}]: ${syms.length} symbols`);
      syms.forEach(s => {
        universe.add(s);
        if (!todaySources.has(s)) todaySources.set(s, new Set());
        todaySources.get(s).add(id);
      });
    } else {
      console.warn(`  screener[${id}]: failed (${r.reason?.message || 'unknown'})`);
    }
  });

  // ── Universe memory: tickers seen in any screener over the past 30 days ──
  // Allows discovery of stocks that briefly showed up in a screener (e.g., one-day
  // gainer) but haven't appeared since — they may still be early-momentum names.
  const memory = loadJSON('universe_memory.json', { tickers: {} });
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  // Add/update today's screener tickers in memory
  todaySources.forEach((sources, ticker) => {
    const existing = memory.tickers[ticker];
    if (existing) {
      existing.lastSeen = todayISO;
      const merged = new Set([...(existing.sources || []), ...sources]);
      existing.sources = [...merged];
    } else {
      memory.tickers[ticker] = {
        firstSeen: todayISO,
        lastSeen:  todayISO,
        sources:   [...sources],
      };
    }
  });

  // Drop entries not seen in 30+ days; surviving entries enrich the universe
  let droppedCount = 0;
  for (const [ticker, entry] of Object.entries(memory.tickers)) {
    const lastSeenMs = Date.parse(entry.lastSeen);
    if (Number.isFinite(lastSeenMs) && (now - lastSeenMs) > THIRTY_DAYS_MS) {
      delete memory.tickers[ticker];
      droppedCount += 1;
    } else if (!isEtf(ticker)) {
      universe.add(ticker);
    }
  }

  saveJSON('universe_memory.json', memory);
  console.log(`  memory: ${Object.keys(memory.tickers).length} tickers retained (dropped ${droppedCount} >30d)`);

  const allSymbols = [...universe].sort(() => Math.random() - 0.5);
  console.log(`  Universe: ${allSymbols.length} symbols`);

  // Load OHLCV cache once — used in steps 2 and 3.
  const ohlcvCache = loadJSON('ohlcv_cache.json', {});

  // 2. SPY + sector benchmarks (now also cached via OHLCV cache)
  console.log('\n[2] Fetching benchmarks...');
  let benchReturn = 0;
  const sectorBenchmarks = {}; // sym → ret12_1

  // 2026-05-16: Yahoo intermittently rate-limits GitHub Actions runner IPs.
  // SPY is our canary — if it fails, this runner is likely banned. Abort with
  // non-zero exit so the workflow fails LOUDLY (instead of silently committing
  // empty data). Next cron run (3h later) will land on a different runner.
  const SECTOR_ETFS_SCAN = ['SMH','IGV','XLK','XLC','XLY','XLI','XLF','XLB','XLE','IBB','XAR','GDX','XLV','XLP','XLU','XLRE','TAN'];
  try {
    const spy = await getOHLCVCached('SPY', ohlcvCache);
    if (!spy || !spy.closes || spy.closes.length < 100) {
      throw new Error('SPY returned empty data — likely IP-banned by Yahoo');
    }
    const n = spy.closes.length;
    benchReturn = (spy.closes[Math.max(0, n - 21)] - spy.closes[0]) / spy.closes[0] * 100;
    console.log(`  SPY 12-1mo: ${benchReturn.toFixed(2)}% ${spy._fromCache ? '(cache)' : ''}`);
  } catch (e) {
    console.error(`\n  ❌ SPY benchmark failed: ${e.message}`);
    console.error('  This runner appears to be IP-banned by Yahoo. Aborting.');
    console.error('  Next scheduled run will retry on a different runner IP.\n');
    process.exit(2);  // distinctive exit code = "IP banned, retry later"
  }

  // Fetch sector ETF returns for relative sector RS (cached)
  try {
    const sectorResults = await Promise.allSettled(
      SECTOR_ETFS_SCAN.map(async sym => {
        const { closes } = await getOHLCVCached(sym, ohlcvCache);
        const n = closes.length;
        return { sym, ret: (closes[Math.max(0, n - 21)] - closes[0]) / closes[0] * 100 };
      })
    );
    sectorResults.forEach(r => {
      if (r.status === 'fulfilled') sectorBenchmarks[r.value.sym] = r.value.ret;
    });
    console.log(`  Sector benchmarks loaded: ${Object.keys(sectorBenchmarks).length}`);
  } catch(e) { console.warn('  Sector benchmarks failed:', e.message); }

  // 3. Scan all symbols
  // 2026-05-16: batch 50 + OHLCV cache with TTL (warm runs ~70% hit).
  // Chart endpoint is plain (no cookie), can sustain higher concurrency.
  const BATCH = 50, BATCH_DELAY = 100;
  let ohlcvHits = 0, ohlcvFetches = 0;
  console.log(`\n[3] Scanning ${allSymbols.length} symbols (batch=${BATCH}, cache=${Object.keys(ohlcvCache).length})...`);

  const leaders   = [];  // confirmed momentum (12-1mo RS)
  const discoCand = [];  // acceleration discovery (3-mo accel)

  for (let i = 0; i < allSymbols.length; i += BATCH) {
    const batch = allSymbols.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(async sym => {
      try {
        const ohlcv = await getOHLCVCached(sym, ohlcvCache);
        if (ohlcv._fromCache) ohlcvHits++; else ohlcvFetches++;
        const { closes, highs, lows, volumes, meta } = ohlcv;
        // Need at least 3 months of data; leaders need 12mo
        if (closes.length < 60) return null;

        const m = calcMetrics(closes, highs, volumes, meta, benchReturn);
        const vcp = calcVCPv2(closes, highs, lows, volumes);

        // ── Leader filter (12-1mo confirmed momentum) ──
        const isLeader = closes.length >= 200
          && m.price >= m.ma50
          && m.avgVol20 >= 150000
          && m.ret12_1 > 0;

        // ── Discovery filter (3-mo acceleration) ──
        const isDiscovery = m.ret3m != null
          && m.ret3m >= 25               // strong 3-month return
          && m.accel != null
          && m.accel >= 1.15             // recent month accelerating vs 3-mo avg
          && m.volExpand >= 1.3          // volume expanding
          && m.volTrend >= 0.9           // volume trend not declining
          && m.avgVol20 >= 100000;       // minimum liquidity

        if (!isLeader && !isDiscovery) return null;

        // Sector ETF + sectorRS are resolved in a post-batch step using Yahoo's
        // assetProfile (industry/sector → ETF) with a 1-year disk cache. See
        // the lookup block right after this scan loop.
        const base = {
          symbol: sym,
          name: meta.shortName || meta.longName || sym,
          price:      round2(m.price),
          changePct:  round2(m.changePct),
          ret1m:      round2(m.ret1m),
          ret3m:      round2(m.ret3m),
          ret6m:      round2(m.ret6m),
          ret12_1:    round2(m.ret12_1),
          rs12_1:     round2(m.rs12_1),
          sector:     null,
          industry:   null,
          sectorEtf:  null,
          sectorRS:   null,
          accel:      round2(m.accel),
          volExpand:  round2(m.volExpand),
          volTrend:   round2(m.volTrend),
          ma50:       round2(m.ma50),
          avgVol20:   Math.round(m.avgVol20),
          high52w:    round2(m.high52w),
          high3m:     round2(m.high3m),
          vcpScore:        vcp.vcpScore,
          vcpDepth:        vcp.vcpDepth ?? null,
          vcpBaseNumber:   vcp.baseNumber ?? 0,
          vcpPivot:        vcp.pivotPrice ?? null,
          vcpBaseDays:     vcp.baseDays ?? 0,
          vcpPriorPullbackPct: vcp.priorPullbackPct ?? null,
          isLeader,
          isDiscovery,
          _ret12_1Raw: m.ret12_1, // kept for sectorRS calc below
        };
        return base;
      } catch (e) { return null; }
    }));

    settled.forEach(s => {
      if (s.status !== 'fulfilled' || !s.value) return;
      const v = s.value;
      if (v.isLeader)    leaders.push(v);
      if (v.isDiscovery) discoCand.push(v);
    });

    process.stdout.write(`  ${Math.min(i + BATCH, allSymbols.length)}/${allSymbols.length} (L:${leaders.length} D:${discoCand.length} cache=${ohlcvHits})\r`);
    // Adaptive delay: only sleep if we actually hit network this batch
    const batchFetched = settled.filter(s => s.status === 'fulfilled' && s.value).length;
    if (i + BATCH < allSymbols.length && batchFetched > BATCH * 0.3) await DELAY(BATCH_DELAY);
  }
  console.log(`\n  OHLCV cache: ${ohlcvHits} hits, ${ohlcvFetches} fetches`);
  saveJSON('ohlcv_cache.json', ohlcvCache);

  console.log(`\n  Leaders: ${leaders.length} | Discovery candidates: ${discoCand.length}`);
  if (leaders.length === 0) { console.error('No leaders — aborting'); return; }

  // 3b. Resolve sector ETF for every passing ticker via Yahoo assetProfile.
  // Cached for 1 year in data/sector_cache.json — most symbols hit cache after day 1.
  // 2026-05-16 fix: prioritize uncached targets up to a fetch budget; rest fall
  // through to next run. Prevents first-run cold-start from blowing past 25min.
  console.log('\n[3b] Resolving sectors via Yahoo assetProfile...');
  const sectorCache = loadJSON('sector_cache.json', {});
  const sectorAllTargets = [...new Set([...leaders, ...discoCand].map(r => r.symbol))];
  // Budget: only attempt up to MAX_SECTOR_FETCHES uncached symbols per run
  const MAX_SECTOR_FETCHES = 80;
  let sectorFetchBudget = MAX_SECTOR_FETCHES;
  const sectorTargets = sectorAllTargets.filter(sym => {
    if (sectorCache[sym]) return true; // already cached → cheap, always include
    if (sectorFetchBudget > 0) { sectorFetchBudget -= 1; return true; }
    return false; // over budget → skip this run
  });
  console.log(`  Sector targets: ${sectorTargets.length}/${sectorAllTargets.length} (${sectorAllTargets.length - sectorTargets.length} deferred over budget)`);
  let sectorCacheHits = 0, sectorFetches = 0, sectorResolved = 0;

  const SECTOR_BATCH = 10, SECTOR_DELAY = 200;
  for (let i = 0; i < sectorTargets.length; i += SECTOR_BATCH) {
    const batch = sectorTargets.slice(i, i + SECTOR_BATCH);
    await Promise.all(batch.map(async sym => {
      const cachedBefore = !!sectorCache[sym];
      const info = await lookupSectorWithCache(sym, sectorCache);
      if (cachedBefore) sectorCacheHits += 1; else sectorFetches += 1;
      if (info.etf) sectorResolved += 1;
    }));
    if (i + SECTOR_BATCH < sectorTargets.length) await DELAY(SECTOR_DELAY);
  }
  saveJSON('sector_cache.json', sectorCache);

  // Apply sector info to records (compute sectorRS using cached benchmarks)
  const applySector = (r) => {
    const info = sectorCache[r.symbol];
    if (info) {
      r.sector    = info.sector;
      r.industry  = info.industry;
      r.sectorEtf = info.etf;
      const benchRet = info.etf && sectorBenchmarks[info.etf] != null ? sectorBenchmarks[info.etf] : null;
      r.sectorRS = (benchRet != null && r._ret12_1Raw != null) ? round2(r._ret12_1Raw - benchRet) : null;
    }
    delete r._ret12_1Raw;
  };
  leaders.forEach(applySector);
  discoCand.forEach(applySector);

  const sectorCoverageL = leaders.filter(r => r.sectorEtf).length;
  const sectorCoverageD = discoCand.filter(r => r.sectorEtf).length;
  console.log(`  sector cache: ${sectorCacheHits} hits, ${sectorFetches} fetches`);
  console.log(`  coverage: leaders ${sectorCoverageL}/${leaders.length} (${Math.round(100*sectorCoverageL/Math.max(1,leaders.length))}%) · discovery ${sectorCoverageD}/${discoCand.length}`);

  // 3c. Enrich each passing ticker with earnings / short / analyst data.
  // Cached in data/quote_cache.json for 24h. Only fetched for leaders+discovery
  // (~200-400 tickers, vs the full ~1500 universe).
  // 2026-05-16 fix: prioritize uncached up to budget; defer rest to next run.
  console.log('\n[3c] Fetching earnings / short / analyst data...');
  const quoteCache = loadJSON('quote_cache.json', {});
  const quoteAllTargets = [...new Set([...leaders, ...discoCand].map(r => r.symbol))];
  const MAX_QUOTE_FETCHES = 60;
  let quoteFetchBudget = MAX_QUOTE_FETCHES;
  const quoteTargets = quoteAllTargets.filter(sym => {
    const fresh = quoteCache[sym]
      && quoteCache[sym].cachedAt
      && (Date.now() - quoteCache[sym].cachedAt) < 24 * 60 * 60 * 1000;
    if (fresh) return true;
    if (quoteFetchBudget > 0) { quoteFetchBudget -= 1; return true; }
    return false;
  });
  console.log(`  Quote targets: ${quoteTargets.length}/${quoteAllTargets.length} (${quoteAllTargets.length - quoteTargets.length} deferred over budget)`);
  let quoteCacheHits = 0, quoteFetches = 0;

  const QUOTE_BATCH = 10, QUOTE_DELAY = 250;
  const quoteResults = {}; // sym → extracted fields
  for (let i = 0; i < quoteTargets.length; i += QUOTE_BATCH) {
    const batch = quoteTargets.slice(i, i + QUOTE_BATCH);
    await Promise.all(batch.map(async sym => {
      const fresh = quoteCache[sym]
        && quoteCache[sym].cachedAt
        && (Date.now() - quoteCache[sym].cachedAt) < 24 * 60 * 60 * 1000;
      if (fresh) quoteCacheHits += 1; else quoteFetches += 1;
      quoteResults[sym] = await lookupQuoteWithCache(sym, quoteCache);
    }));
    if (i + QUOTE_BATCH < quoteTargets.length) await DELAY(QUOTE_DELAY);
  }
  saveJSON('quote_cache.json', quoteCache);

  const applyQuote = (r) => {
    const q = quoteResults[r.symbol];
    if (!q) {
      r.earningsDate     = null;
      r.daysToEarnings   = null;
      r.shortPctOfFloat  = null;
      r.shortRatio       = null;
      r.recentUpgrades   = [];
      r.recentDowngrades = [];
      r.surpriseHistory  = [];
      r.recommendation   = null;
      return;
    }
    r.earningsDate     = q.earningsDate;
    r.daysToEarnings   = q.daysToEarnings;
    r.shortPctOfFloat  = q.shortPctOfFloat;
    r.shortRatio       = q.shortRatio;
    r.recentUpgrades   = q.recentUpgrades   || [];
    r.recentDowngrades = q.recentDowngrades || [];
    r.surpriseHistory  = q.surpriseHistory  || [];
    r.recommendation   = q.recommendation   || null;
  };
  leaders.forEach(applyQuote);
  discoCand.forEach(applyQuote);

  const earningsCoverageL = leaders.filter(r => r.daysToEarnings != null).length;
  console.log(`  quote cache: ${quoteCacheHits} hits, ${quoteFetches} fetches`);
  console.log(`  earnings coverage: leaders ${earningsCoverageL}/${leaders.length} (${Math.round(100*earningsCoverageL/Math.max(1,leaders.length))}%)`);

  // 4. Score leaders (RS Rating + composite)
  calcRSRatings(leaders);
  leaders.forEach(r => {
    const volScore = Math.min(99, Math.round(r.volExpand * 33));
    const momScore = Math.min(99, Math.max(1, Math.round(50 + r.rs12_1 * 0.6)));
    // Acceleration bonus: accelerating leaders get +3 to composite
    const accelBonus = r.accel != null ? (r.accel >= 1.2 ? 3 : r.accel < 0.8 ? -3 : 0) : 0;
    r.compositeScore = Math.min(99, Math.round(r.rsRating * 0.50 + volScore * 0.30 + momScore * 0.20) + accelBonus);
  });
  leaders.sort((a, b) => b.compositeScore - a.compositeScore);

  // 5. Score discovery candidates
  const leaderSyms = new Set(leaders.slice(0, 25).map(r => r.symbol));
  const discoveries = discoCand
    .filter(r => !leaderSyms.has(r.symbol)) // no duplicates with leaders
    .map(r => {
      // Discovery score: acceleration × vol expansion × 3-month return
      r.discoScore = Math.round(
        (Math.min(r.accel, 3) / 3) * 40 +        // acceleration (40%)
        (Math.min(r.volExpand, 3) / 3) * 30 +     // volume expansion (30%)
        (Math.min(r.ret3m, 100) / 100) * 30       // 3-month return (30%)
      );
      return r;
    })
    .sort((a, b) => b.discoScore - a.discoScore)
    .slice(0, 15);

  // 5b. Triple-Resonance Radar — load any catalyst data and compute candidates.
  // Both data files are produced by their own workflows (insider-scan.yml,
  // news-scan.yml) and may not exist yet — that's fine, the function is
  // defensive and will fall back to whatever signals are present.
  const insiderData    = loadJSON('insider_data.json',    null);
  const newsSentiment  = loadJSON('news_sentiment.json',  null);
  const tripleResonance = computeTripleResonance(
    leaders.slice(0, 25),
    discoveries,
    insiderData,
    newsSentiment,
  );
  console.log(`  triple-resonance: ${tripleResonance.length} candidates (insider data: ${insiderData ? 'yes' : 'no'} · news: ${newsSentiment ? 'yes' : 'no'})`);

  // 6. Save
  const output = {
    scannedAt:    new Date().toISOString(),
    universeSize: allSymbols.length,
    scannedCount: allSymbols.length,
    passedCount:  leaders.length + discoCand.length,
    benchmark:    { symbol: 'SPY', ret12_1: round2(benchReturn) },
    leaders:      leaders.slice(0, 25),
    discoveries,
    tripleResonance,
  };

  writeFileSync(join(DATA_DIR, 'us_scan.json'), JSON.stringify(output, null, 2));
  console.log(`\n[6] Saved → us_scan.json (${output.leaders.length} leaders, ${discoveries.length} discoveries, ${tripleResonance.length} triple-resonance)`);
  console.log(`End: ${new Date().toISOString()}\n`);
}

// ── TW Scan ─────────────────────────────────────────────────────────────────

async function scanTW() {
  console.log('\n=== TW RS Leader Scan ===');

  let benchReturn = 0;
  try {
    const bench = await getOHLCV('0050.TW', '12mo');
    const n = bench.closes.length;
    benchReturn = (bench.closes[Math.max(0, n - 21)] - bench.closes[0]) / bench.closes[0] * 100;
    console.log(`  0050.TW 12-1mo: ${benchReturn.toFixed(2)}%`);
  } catch (e) { console.warn('  0050.TW failed:', e.message); }

  const results = [];
  const BATCH = 8;

  for (let i = 0; i < TW_POOL.length; i += BATCH) {
    const batch = TW_POOL.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(async sym => {
      try {
        const { closes, highs, lows, volumes, meta } = await getOHLCV(sym, '12mo');
        if (closes.length < 60) return null;
        const m = calcMetrics(closes, highs, volumes, meta, benchReturn);
        if (m.price < m.ma50 || m.ret12_1 <= 0) return null;
        const vcp = calcVCPv2(closes, highs, lows, volumes);
        return {
          symbol: sym, name: meta.shortName || sym,
          price: round2(m.price), changePct: round2(m.changePct),
          ret1m: round2(m.ret1m), ret3m: round2(m.ret3m),
          ret12_1: round2(m.ret12_1), rs12_1: round2(m.rs12_1),
          accel: round2(m.accel), volExpand: round2(m.volExpand),
          ma50: round2(m.ma50), avgVol20: Math.round(m.avgVol20),
          high52w: round2(m.high52w), high3m: round2(m.high3m),
          vcpScore: vcp.vcpScore, vcpDepth: vcp.vcpDepth ?? null,
          vcpBaseNumber: vcp.baseNumber ?? 0,
          vcpPivot: vcp.pivotPrice ?? null,
          vcpBaseDays: vcp.baseDays ?? 0,
          vcpPriorPullbackPct: vcp.priorPullbackPct ?? null,
        };
      } catch (e) { return null; }
    }));
    settled.forEach(s => { if (s.status === 'fulfilled' && s.value) results.push(s.value); });
    if (i + BATCH < TW_POOL.length) await DELAY(600);
  }

  calcRSRatings(results);
  results.forEach(r => {
    const volScore = Math.min(99, Math.round(r.volExpand * 33));
    const momScore = Math.min(99, Math.max(1, Math.round(50 + r.rs12_1 * 0.6)));
    r.compositeScore = Math.round(r.rsRating * 0.50 + volScore * 0.30 + momScore * 0.20);
  });
  results.sort((a, b) => b.compositeScore - a.compositeScore);

  const twLeaders = results.slice(0, 25);
  const twDiscos  = results.filter((r, i) => i >= 25 && r.accel != null && r.accel >= 1.15 && r.ret3m != null && r.ret3m >= 15).slice(0, 10);

  writeFileSync(join(DATA_DIR, 'tw_scan.json'), JSON.stringify({
    scannedAt: new Date().toISOString(),
    universeSize: TW_POOL.length, scannedCount: TW_POOL.length, passedCount: results.length,
    benchmark: { symbol: '0050.TW', ret12_1: round2(benchReturn) },
    leaders: twLeaders, discoveries: twDiscos,
  }, null, 2));
  console.log(`Saved → tw_scan.json (${twLeaders.length} leaders, ${twDiscos.length} discoveries)`);
}

// ── Entry ────────────────────────────────────────────────────────────────────

const market = process.argv[2] || 'all';
if (market === 'us' || market === 'all') await scanUS();
if (market === 'tw' || market === 'all') await scanTW();
console.log('Done.');
