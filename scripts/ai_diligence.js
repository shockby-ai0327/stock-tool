/**
 * ai_diligence.js — AI deep-research analyst (Phase 5, research-edge path)
 *
 * WHY THIS EXISTS
 * ---------------
 * Four rounds of rigorous backtesting proved mechanical price signals (momentum,
 * mean-reversion, breakout, PEAD-proxy) have no edge over SPY for this universe.
 * The durable edge the great individual-stock investors (Buffett, Lynch, Greenblatt)
 * have is QUALITATIVE research — understanding a business, not a backtestable signal.
 * That's precisely why a backtest can't find it, and why it survives (can't be
 * commoditised into a screener everyone runs).
 *
 * This agent does the primary-source reading most retail won't: pulls SEC EDGAR
 * filings + key financials for the scanner's top names, and asks Claude to produce
 * a FALSIFIABLE research framework — bull thesis, bear case, explicit invalidation
 * conditions, key risks, and what to verify. It is NOT a buy recommendation; it is
 * a structured starting point for the user's own judgement.
 *
 * Output is stored with a persistent history so the system can later grade its own
 * past calls (did the invalidation conditions trigger? did the thesis play out?).
 *
 * Requires: ANTHROPIC_API_KEY env var. Runs in GitHub Actions.
 */

import fetch from 'node-fetch';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

const API_KEY = process.env.ANTHROPIC_API_KEY;
const SEC_UA = 'stock-tool research/1.0 (contact: shockby-ai0327)';
const MAX_NAMES = 8;            // cost control: ~few cents per name on Haiku
const DELAY = ms => new Promise(r => setTimeout(r, ms));

const _runUsage = { input: 0, output: 0, calls: 0, model: 'claude-haiku-4-5' };

// ── JSON helpers ────────────────────────────────────────────────────────────
function loadJSON(filename, fallback) {
  const p = join(DATA_DIR, filename);
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { console.warn(`  load ${filename}: ${e.message}`); return fallback; }
}
function saveJSON(filename, data) {
  writeFileSync(join(DATA_DIR, filename), JSON.stringify(data, null, 2));
}

// ── SEC fetch (mirror insider_scan.js pattern) ──────────────────────────────
async function secFetch(url, parseAs = 'json', retries = 3) {
  const host = new URL(url).host;
  const headers = { 'User-Agent': SEC_UA, 'Accept': '*/*', 'Host': host };
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (res.status === 429) { await DELAY((attempt + 1) * 2000); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseAs === 'json' ? await res.json() : await res.text();
    } catch (e) {
      if (attempt === retries - 1) throw e;
      await DELAY(1500 * (attempt + 1));
    }
  }
}

// ── CIK map (reuse cached cik_map.json, refresh weekly) ─────────────────────
async function loadCikMap() {
  const cached = loadJSON('cik_map.json', null);
  if (cached?.bySymbol && cached.fetchedAt && (Date.now() - cached.fetchedAt) < 7 * 864e5) {
    return cached.bySymbol;
  }
  try {
    const raw = await secFetch('https://www.sec.gov/files/company_tickers.json');
    const bySymbol = {};
    for (const k of Object.keys(raw)) {
      const e = raw[k];
      if (e?.ticker && e?.cik_str) {
        bySymbol[e.ticker.toUpperCase()] = { cik: String(e.cik_str).padStart(10, '0'), title: e.title || '' };
      }
    }
    saveJSON('cik_map.json', { fetchedAt: Date.now(), bySymbol });
    return bySymbol;
  } catch (e) {
    console.warn('  CIK map fetch failed:', e.message);
    return cached?.bySymbol || {};
  }
}

// ── Recent material filings (10-K / 10-Q / 8-K) ─────────────────────────────
async function getRecentFilings(cik) {
  try {
    const data = await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`);
    const r = data?.filings?.recent;
    if (!r || !Array.isArray(r.form)) return [];
    const out = [];
    for (let i = 0; i < r.form.length && out.length < 8; i++) {
      if (['10-K', '10-Q', '8-K'].includes(r.form[i])) {
        out.push({ form: r.form[i], date: r.filingDate?.[i], doc: r.primaryDocDescription?.[i] || '' });
      }
    }
    return out;
  } catch (e) { return []; }
}

// ── Key financial trend via XBRL companyconcept (targeted, small payloads) ──
async function getConcept(cik, concept) {
  try {
    const d = await secFetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${concept}.json`);
    const usd = d?.units?.USD;
    if (!Array.isArray(usd)) return null;
    // annual values from 10-K, most recent 3
    const annual = usd.filter(x => x.form === '10-K' && x.fp === 'FY' && x.val != null)
                      .sort((a, b) => (a.end < b.end ? 1 : -1));
    const seen = new Set(); const vals = [];
    for (const a of annual) { if (!seen.has(a.fy)) { seen.add(a.fy); vals.push({ fy: a.fy, val: a.val }); } }
    return vals.slice(0, 3);
  } catch (e) { return null; }
}

async function getFinancials(cik) {
  // try common revenue concept names; net income is stable
  const revConcepts = ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'];
  let revenue = null;
  for (const c of revConcepts) {
    revenue = await getConcept(cik, c);
    if (revenue && revenue.length) break;
    await DELAY(150);
  }
  const netIncome = await getConcept(cik, 'NetIncomeLoss');
  return { revenue, netIncome };
}

function fmtTrend(arr, unit = '$') {
  if (!arr || !arr.length) return 'n/a';
  return arr.map(v => `FY${v.fy}: ${unit}${(v.val / 1e6).toFixed(0)}M`).join(' · ');
}

// ── Claude call (mirror ai_analysis.js) ─────────────────────────────────────
async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 700, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(40000),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  if (data.usage) {
    _runUsage.input += data.usage.input_tokens || 0;
    _runUsage.output += data.usage.output_tokens || 0;
    _runUsage.calls++;
  }
  return data.content[0].text.trim();
}

function _writeUsage(scriptName) {
  try {
    const file = join(DATA_DIR, 'api_usage.json');
    let usage = { months: {}, lastUpdated: 0 };
    try { usage = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {}
    const month = new Date().toISOString().slice(0, 7);
    if (!usage.months[month]) usage.months[month] = { input: 0, output: 0, calls: 0, byScript: {} };
    const m = usage.months[month];
    m.input += _runUsage.input; m.output += _runUsage.output; m.calls += _runUsage.calls;
    if (!m.byScript[scriptName]) m.byScript[scriptName] = { input: 0, output: 0, calls: 0 };
    m.byScript[scriptName].input += _runUsage.input;
    m.byScript[scriptName].output += _runUsage.output;
    m.byScript[scriptName].calls += _runUsage.calls;
    const months = Object.keys(usage.months).sort().reverse().slice(0, 6);
    usage.months = Object.fromEntries(months.map(k => [k, usage.months[k]]));
    usage.lastUpdated = Date.now();
    writeFileSync(file, JSON.stringify(usage, null, 2));
    console.log(`📊 usage: ${_runUsage.input} in / ${_runUsage.output} out / ${_runUsage.calls} calls`);
  } catch (e) { console.warn('  writeUsage:', e.message); }
}

// ── Diligence prompt (falsifiable framework, NOT a buy call) ────────────────
function buildPrompt(sym, title, scan, filings, fin) {
  const filingStr = filings.length
    ? filings.map(f => `${f.form} (${f.date})`).join(', ')
    : '近期重大申報資料無法取得';
  const px = scan?.price != null ? `$${scan.price}` : 'n/a';
  const fromHigh = (scan?.price && scan?.high52w) ? ((scan.price / scan.high52w - 1) * 100).toFixed(1) + '%' : 'n/a';

  return `你是嚴謹的買方研究分析師。針對 ${sym}（${title}）產生一份「可證偽的研究框架」，不是買賣建議。

# 已知事實
- 現價 ${px}，距52週高 ${fromHigh}，RS Rating ${scan?.rsRating ?? 'n/a'}
- 近期 SEC 申報：${filingStr}
- 營收趨勢：${fmtTrend(fin.revenue)}
- 淨利趨勢：${fmtTrend(fin.netIncome)}

# 任務
基於上述事實 + 你對這家公司/產業的既有知識，輸出**純 JSON**（不要 markdown、不要多餘文字）：
{
  "bull": "多方論點，1-2句，具體",
  "bear": "空方論點/最大風險，1-2句，要真的能打臉多方",
  "invalidation": ["明確的失效條件1（可觀察、可量化）", "失效條件2"],
  "verify": ["進場前該親自查證的關鍵問題1", "問題2"],
  "moat": "護城河評估，一句（強/中/弱 + 原因）",
  "conviction": 1到5的整數（5=高信心值得深入研究，1=不值得花時間）,
  "oneLineAsk": "用一句話總結：這檔最該回答的問題是什麼"
}

規則：誠實優先。若資料不足或你不熟這家公司，conviction 給低分並在 bear/verify 說明。不要編造數字。不要說「買進」「賣出」「目標價」。`;
}

function parseJSON(text) {
  let t = text.trim();
  if (t.startsWith('```')) t = t.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!API_KEY) { console.error('❌ ANTHROPIC_API_KEY not set. Skipping.'); return; }
  console.log('=== AI Due-Diligence Analyst ===');

  const scan = loadJSON('us_scan.json', null);
  if (!scan?.leaders?.length) { console.warn('No us_scan.json leaders — nothing to research.'); return; }

  // research the top N leaders + any triple-resonance names (highest interest)
  const names = [];
  const seen = new Set();
  for (const s of [...(scan.tripleResonance || []), ...scan.leaders]) {
    if (s?.symbol && !seen.has(s.symbol)) { seen.add(s.symbol); names.push(s); }
    if (names.length >= MAX_NAMES) break;
  }
  console.log(`  researching ${names.length}: ${names.map(n => n.symbol).join(', ')}`);

  const cikMap = await loadCikMap();
  const prior = loadJSON('ai_diligence.json', { theses: {}, history: [] });
  const theses = {};
  const history = Array.isArray(prior.history) ? prior.history : [];

  for (const stock of names) {
    const sym = stock.symbol;
    const entry = cikMap[sym.toUpperCase()];
    if (!entry) { console.log(`  ${sym}: no CIK, skip`); continue; }
    try {
      const [filings, fin] = [await getRecentFilings(entry.cik), await getFinancials(entry.cik)];
      const out = parseJSON(await callClaude(buildPrompt(sym, entry.title, stock, filings, fin)));
      out.symbol = sym;
      out.priceAtAnalysis = stock.price ?? null;
      out.dataAsOf = new Date().toISOString();
      out.recentFilings = filings.slice(0, 5);
      theses[sym] = out;
      history.push({ symbol: sym, date: new Date().toISOString().slice(0, 10),
                     conviction: out.conviction, priceAtAnalysis: stock.price ?? null });
      console.log(`  ${sym}: conviction ${out.conviction}/5 — ${(out.oneLineAsk || '').slice(0, 50)}`);
      await DELAY(400);
    } catch (e) {
      console.warn(`  ${sym}: ${e.message}`);
    }
  }

  // cap history at 2000 entries
  const trimmed = history.slice(-2000);
  saveJSON('ai_diligence.json', { generatedAt: Date.now(), theses, history: trimmed });
  console.log(`  wrote ai_diligence.json: ${Object.keys(theses).length} theses, ${trimmed.length} history`);
  _writeUsage('ai_diligence');
}

main().catch(e => { console.error('FATAL:', e); process.exitCode = 1; });
