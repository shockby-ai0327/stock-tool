/**
 * backtest.js — Signal performance tracker
 *
 * Wave 3 / Task 3.1 of the improvement plan.
 *
 * Reads `data/us_scan.json` (latest scan) and accumulates every newly-
 * triggered signal into `data/signal_history.json`. Then for each open
 * signal in the cumulative history, fetches the current price and marks
 * it `hit_target`, `hit_stop`, or `timed_out` if any threshold is hit.
 * Finally rolls up trailing-252-day stats per signal type and writes
 * `data/signal_stats.json` for the frontend to display.
 *
 * Signal types tracked:
 *   - rs_leader         all stocks in leaders[]
 *   - discovery         all stocks in discoveries[]
 *   - triple_resonance  all stocks in tripleResonance[]
 *   - vcp_breakout      leaders/discoveries with vcpScore >= 3
 *   - earnings_play     leaders/discoveries with daysToEarnings <= 14 AND vcpScore >= 2
 *
 * The script is intentionally defensive: many older scan entries lack
 * vcpScore / daysToEarnings (added in Wave 2), so missing fields are
 * silently skipped. The history file caps at 10,000 entries — oldest
 * closed entries are dropped first when over.
 *
 * Designed to be invoked from a GitHub Actions workflow that runs after
 * every successful Stock RS Leader Scan (see .github/workflows/backtest.yml).
 */

import fetch from 'node-fetch';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

const DELAY = ms => new Promise(r => setTimeout(r, ms));
const YF_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Tuning constants ────────────────────────────────────────────────────────
const STOP_PCT       = 0.08;        // 8% trailing stop, matching scanner UI
const TARGET_PCT     = 0.15;        // +15% default target when ATR unavailable
const TIMEOUT_DAYS   = 60;          // signals older than this auto-close as timed_out
const MAX_HISTORY    = 10000;       // hard cap on cumulative history entries
const STATS_WINDOW_D = 252;         // trailing window for rolling stats

// ── JSON helpers ────────────────────────────────────────────────────────────
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

// ── Yahoo chart fetch (no auth required for v8 endpoint) ────────────────────
async function fetchCurrentPrice(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': YF_UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    // Prefer regularMarketPrice from meta (latest live-ish), else last close
    const meta = result.meta || {};
    if (meta.regularMarketPrice != null) return meta.regularMarketPrice;
    const closes = result.indicators?.quote?.[0]?.close || [];
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null) return closes[i];
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ── Signal extraction from scan output ──────────────────────────────────────
// Returns an array of { type, symbol, entryPrice } records that should
// become open signals if not already in history.
function extractSignalsFromScan(scan) {
  const out = [];
  const seen = new Set(); // dedupe within a single scan: type+symbol
  const push = (type, stock) => {
    if (!stock || !stock.symbol) return;
    const price = Number(stock.price);
    if (!Number.isFinite(price) || price <= 0) return;
    const key = `${type}|${stock.symbol}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ type, symbol: stock.symbol, entryPrice: price });
  };

  const leaders = Array.isArray(scan?.leaders) ? scan.leaders : [];
  const discoveries = Array.isArray(scan?.discoveries) ? scan.discoveries : [];
  const triple = Array.isArray(scan?.tripleResonance) ? scan.tripleResonance : [];

  leaders.forEach(s => push('rs_leader', s));
  discoveries.forEach(s => push('discovery', s));
  triple.forEach(s => push('triple_resonance', s));

  // Subset signals: VCP breakout and earnings play
  for (const s of [...leaders, ...discoveries]) {
    const vcp = Number(s?.vcpScore) || 0;
    const dte = (s?.daysToEarnings != null) ? Number(s.daysToEarnings) : null;
    if (vcp >= 3) push('vcp_breakout', s);
    if (vcp >= 2 && dte != null && dte >= 0 && dte <= 14) push('earnings_play', s);
  }

  return out;
}

// ── Signal id format: <type>_<YYYY-MM-DD>_<SYMBOL> ──────────────────────────
function signalId(type, symbol, dateISO) {
  const ymd = (dateISO || new Date().toISOString()).slice(0, 10);
  return `${type}_${ymd}_${symbol}`;
}

function makeNewEntry(sig, triggeredAt) {
  const entry = Number(sig.entryPrice);
  return {
    id:          signalId(sig.type, sig.symbol, triggeredAt),
    type:        sig.type,
    symbol:      sig.symbol,
    triggeredAt,
    entryPrice:  entry,
    exitPrice:   null,
    exitDate:    null,
    stopLoss:    +(entry * (1 - STOP_PCT)).toFixed(4),
    target:      +(entry * (1 + TARGET_PCT)).toFixed(4),
    status:      'open',
  };
}

// ── Roll-forward open signals ───────────────────────────────────────────────
// For each open signal, fetch current price and mark target/stop/timeout.
// Returns count of closed signals this run for log output.
async function updateOpenSignals(history) {
  const open = history.signals.filter(s => s.status === 'open');
  if (!open.length) return 0;

  // Batch: fetch unique symbols once each (some symbols may have multiple
  // open signals of different types).
  const uniqueSymbols = [...new Set(open.map(s => s.symbol))];
  console.log(`  fetching current prices for ${uniqueSymbols.length} unique symbols across ${open.length} open signals`);

  const priceMap = new Map();
  const BATCH = 6;
  for (let i = 0; i < uniqueSymbols.length; i += BATCH) {
    const batch = uniqueSymbols.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(sym => fetchCurrentPrice(sym)));
    settled.forEach((r, j) => {
      if (r.status === 'fulfilled' && r.value != null) priceMap.set(batch[j], r.value);
    });
    if (i + BATCH < uniqueSymbols.length) await DELAY(400);
  }

  const now = Date.now();
  let closed = 0;
  for (const sig of open) {
    const price = priceMap.get(sig.symbol);
    const ageDays = (now - Date.parse(sig.triggeredAt)) / 86400000;

    if (price != null) {
      if (price >= sig.target) {
        sig.status = 'hit_target';
        sig.exitPrice = +price.toFixed(4);
        sig.exitDate = new Date().toISOString();
        closed++;
        continue;
      }
      if (price <= sig.stopLoss) {
        sig.status = 'hit_stop';
        sig.exitPrice = +price.toFixed(4);
        sig.exitDate = new Date().toISOString();
        closed++;
        continue;
      }
    }
    // Timeout regardless of price availability — if we can't get a price after
    // 60 days, the signal is meaningless anyway; use last known price (entry)
    // as a conservative neutral exit.
    if (ageDays > TIMEOUT_DAYS) {
      sig.status = 'timed_out';
      sig.exitPrice = +(price != null ? price : sig.entryPrice).toFixed(4);
      sig.exitDate = new Date().toISOString();
      closed++;
    }
  }
  return closed;
}

// ── Stats computation ───────────────────────────────────────────────────────
function percentReturn(sig) {
  if (sig.exitPrice == null || sig.entryPrice == null || sig.entryPrice <= 0) return null;
  return ((sig.exitPrice - sig.entryPrice) / sig.entryPrice) * 100;
}

function holdDays(sig) {
  if (!sig.exitDate || !sig.triggeredAt) return null;
  return (Date.parse(sig.exitDate) - Date.parse(sig.triggeredAt)) / 86400000;
}

function computeStatsForType(signals) {
  const cutoff = Date.now() - STATS_WINDOW_D * 86400000;
  // Universe: signals triggered in last 252d (open + closed)
  const inWindow = signals.filter(s => Date.parse(s.triggeredAt) >= cutoff);
  const closed   = inWindow.filter(s => s.status !== 'open');
  const open     = inWindow.filter(s => s.status === 'open');

  if (closed.length < 20) {
    return {
      trailing_252d: {
        insufficientData: true,
        sampleSize: closed.length,
        total: inWindow.length,
        open: open.length,
      },
    };
  }

  const returns = closed.map(percentReturn).filter(r => r != null);
  const wins    = returns.filter(r => r > 0);
  const losses  = returns.filter(r => r <= 0);
  const holds   = closed.map(holdDays).filter(d => d != null && d > 0);

  const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const stddev = arr => {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / (arr.length - 1);
    return Math.sqrt(v);
  };

  const avgReturn   = mean(returns);
  const sd          = stddev(returns);
  const avgHoldDays = holds.length ? mean(holds) : null;

  // Annualized Sharpe-ish: (mean return / stddev) × sqrt(252 / avgHoldDays)
  // This translates per-trade return to an annualized basis given the
  // average holding period. Defensive when stddev or avgHoldDays missing.
  let sharpe = null;
  if (sd > 0 && avgHoldDays && avgHoldDays > 0) {
    sharpe = (avgReturn / sd) * Math.sqrt(252 / avgHoldDays);
  }

  return {
    trailing_252d: {
      total:    inWindow.length,
      winners:  wins.length,
      losers:   losses.length,
      open:     open.length,
      winRate:  closed.length ? +(wins.length / closed.length).toFixed(4) : 0,
      avgWin:   wins.length   ? +mean(wins).toFixed(2) : 0,
      avgLoss:  losses.length ? +mean(losses).toFixed(2) : 0,
      avgReturn: +avgReturn.toFixed(2),
      sharpe:    sharpe != null ? +sharpe.toFixed(2) : null,
      avgHoldDays: avgHoldDays != null ? Math.round(avgHoldDays) : null,
    },
  };
}

function computeAllStats(history) {
  const types = ['rs_leader', 'discovery', 'triple_resonance', 'vcp_breakout', 'earnings_play'];
  const stats = {};
  for (const t of types) {
    const sigs = history.signals.filter(s => s.type === t);
    stats[t] = computeStatsForType(sigs);
  }
  // 2026-05-20: 修「493749 小時前更新」bug — 原本存秒，前端拿 ms 計算 = 1000 倍誤差
  return { computedAt: Date.now(), stats };
}

// ── History cap ─────────────────────────────────────────────────────────────
// If total exceeds MAX_HISTORY, drop oldest closed entries first, keeping
// all open entries (they're still informative and small).
function capHistory(history) {
  if (history.signals.length <= MAX_HISTORY) return;
  const overflow = history.signals.length - MAX_HISTORY;
  // Sort closed by triggeredAt asc; drop the oldest `overflow` closed
  const closedSorted = history.signals
    .filter(s => s.status !== 'open')
    .sort((a, b) => Date.parse(a.triggeredAt) - Date.parse(b.triggeredAt));
  const toDrop = new Set(closedSorted.slice(0, overflow).map(s => s.id));
  history.signals = history.signals.filter(s => !toDrop.has(s.id));
  console.log(`  capped history: dropped ${toDrop.size} oldest closed entries`);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Backtest signal tracker ===');
  console.log(`Start: ${new Date().toISOString()}`);

  // 1. Load latest scan + cumulative history
  const scan = loadJSON('us_scan.json', null);
  if (!scan) {
    console.warn('No us_scan.json — nothing to backtest. Exiting clean.');
    return;
  }
  console.log(`  scan from ${scan.scannedAt}: ${(scan.leaders||[]).length} leaders, ` +
              `${(scan.discoveries||[]).length} discoveries, ` +
              `${(scan.tripleResonance||[]).length} triple-resonance`);

  const history = loadJSON('signal_history.json', { signals: [] });
  if (!Array.isArray(history.signals)) history.signals = [];
  const initialCount = history.signals.length;
  console.log(`  loaded history: ${initialCount} existing entries`);

  // 2. Extract today's signals from scan and add new ones (deduped by id)
  const triggeredAt = scan.scannedAt || new Date().toISOString();
  const todaysSignals = extractSignalsFromScan(scan);
  const existingIds = new Set(history.signals.map(s => s.id));
  let added = 0;
  for (const sig of todaysSignals) {
    const id = signalId(sig.type, sig.symbol, triggeredAt);
    if (existingIds.has(id)) continue;
    history.signals.push(makeNewEntry(sig, triggeredAt));
    added++;
  }
  console.log(`  appended ${added} new signal entries (of ${todaysSignals.length} extracted)`);

  // 3. Roll-forward all open signals (check target/stop/timeout)
  const closed = await updateOpenSignals(history);
  console.log(`  closed ${closed} signals this run`);

  // 4. Cap history size
  capHistory(history);

  // 5. Save history
  saveJSON('signal_history.json', history);
  console.log(`  saved signal_history.json: ${history.signals.length} entries`);

  // 6. Compute + save rolling stats
  const stats = computeAllStats(history);
  saveJSON('signal_stats.json', stats);

  // Concise summary
  for (const type of Object.keys(stats.stats)) {
    const s = stats.stats[type].trailing_252d;
    if (s.insufficientData) {
      console.log(`  ${type.padEnd(18)}: N=${s.sampleSize} (insufficient, need 20+)`);
    } else {
      console.log(`  ${type.padEnd(18)}: ${s.total} signals · win ${(s.winRate*100).toFixed(1)}% · ` +
                  `avg ${s.avgReturn >= 0 ? '+' : ''}${s.avgReturn.toFixed(2)}% · ` +
                  `Sharpe ${s.sharpe != null ? s.sharpe.toFixed(2) : 'n/a'} · hold ${s.avgHoldDays}d`);
    }
  }

  console.log(`End: ${new Date().toISOString()}`);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
