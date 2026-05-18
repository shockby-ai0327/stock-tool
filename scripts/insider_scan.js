/**
 * insider_scan.js — SEC EDGAR Form 4 insider buying detector
 *
 * Reads tickers from data/us_scan.json (leaders + discoveries), looks up each
 * one's CIK via SEC's company_tickers.json (cached 7 days in data/cik_map.json),
 * fetches recent filings via data.sec.gov/submissions/CIK{padded10}.json,
 * filters for Form 4 in the past 30 days, parses the XML for purchases (code P).
 *
 * Output: data/insider_data.json
 *   { generatedAt: ..., bySymbol: { TICKER: { filings:[], totalValue30d, buyerCount30d, clusterBuy } } }
 *
 * SEC rate limit: max 10 req/sec. We use ~5 req/sec to be safe.
 * Required: User-Agent header with contact info per SEC guidelines.
 */

import fetch from 'node-fetch';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

const DELAY = ms => new Promise(r => setTimeout(r, ms));

const SEC_UA = 'StockAnalysisTool research@example.com';
const SEC_HEADERS = {
  'User-Agent':      SEC_UA,
  'Accept':          'application/json, text/xml;q=0.9, */*;q=0.8',
  'Accept-Encoding': 'gzip, deflate',
  'Host':            undefined, // set per-request below
};

// ── JSON helpers (defensive) ──────────────────────────────────────────────
function loadJSON(filename, fallback) {
  const path = join(DATA_DIR, filename);
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { console.warn(`  load ${filename}: ${e.message}`); return fallback; }
}
function saveJSON(filename, data) {
  writeFileSync(join(DATA_DIR, filename), JSON.stringify(data, null, 2));
}

// ── SEC fetcher with retry ────────────────────────────────────────────────
async function secFetch(url, parseAs = 'json', retries = 3) {
  const host = new URL(url).host;
  const headers = { 'User-Agent': SEC_UA, 'Accept': '*/*', 'Host': host };
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (res.status === 429) {
        const wait = (attempt + 1) * 2000;
        console.log(`  429 from SEC, waiting ${wait}ms...`);
        await DELAY(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseAs === 'json' ? await res.json() : await res.text();
    } catch (e) {
      if (attempt === retries - 1) throw e;
      await DELAY(1500 * (attempt + 1));
    }
  }
}

// ── CIK lookup with 7-day cache ───────────────────────────────────────────
// SEC publishes the full ticker→CIK map at company_tickers.json.
// Format: { "0": { "cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc." }, ... }
async function loadCikMap() {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const cached = loadJSON('cik_map.json', null);
  if (cached && cached.fetchedAt && (Date.now() - cached.fetchedAt) < SEVEN_DAYS_MS) {
    console.log(`  CIK map: using cached (${Object.keys(cached.bySymbol || {}).length} symbols)`);
    return cached.bySymbol || {};
  }

  console.log('  CIK map: fetching from SEC...');
  try {
    const raw = await secFetch('https://www.sec.gov/files/company_tickers.json');
    const bySymbol = {};
    for (const key of Object.keys(raw)) {
      const entry = raw[key];
      if (entry && entry.ticker && entry.cik_str) {
        bySymbol[entry.ticker.toUpperCase()] = {
          cik:   String(entry.cik_str).padStart(10, '0'),
          title: entry.title || '',
        };
      }
    }
    saveJSON('cik_map.json', { fetchedAt: Date.now(), bySymbol });
    console.log(`  CIK map: cached ${Object.keys(bySymbol).length} symbols`);
    return bySymbol;
  } catch (e) {
    console.warn(`  CIK map fetch failed: ${e.message}`);
    return cached?.bySymbol || {};
  }
}

// ── Form 4 submission index fetch + filter ───────────────────────────────
async function getRecentForm4Filings(cik) {
  const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
  const data = await secFetch(url);
  const recent = data?.filings?.recent;
  if (!recent || !Array.isArray(recent.form)) return [];

  const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const out = [];
  for (let i = 0; i < recent.form.length; i++) {
    if (recent.form[i] !== '4') continue;
    const filingDateStr = recent.filingDate?.[i];
    if (!filingDateStr) continue;
    const filingDateMs = Date.parse(filingDateStr);
    if (!Number.isFinite(filingDateMs) || filingDateMs < cutoffMs) continue;
    out.push({
      accession:    recent.accessionNumber?.[i] || '',
      filingDate:   filingDateStr,
      primaryDoc:   recent.primaryDocument?.[i] || '',
    });
  }
  return out;
}

// ── Form 4 XML parsing (lightweight, no external deps) ───────────────────
// Form 4 XML structure (relevant fields):
//   <ownershipDocument>
//     <reportingOwner>
//       <reportingOwnerId><rptOwnerName>JANE DOE</rptOwnerName></reportingOwnerId>
//       <reportingOwnerRelationship>
//         <isDirector>1</isDirector>
//         <isOfficer>1</isOfficer>
//         <officerTitle>Chief Financial Officer</officerTitle>
//       </reportingOwnerRelationship>
//     </reportingOwner>
//     <nonDerivativeTable>
//       <nonDerivativeTransaction>
//         <transactionDate><value>2026-05-10</value></transactionDate>
//         <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
//         <transactionAmounts>
//           <transactionShares><value>5000</value></transactionShares>
//           <transactionPricePerShare><value>12.50</value></transactionPricePerShare>
//         </transactionAmounts>
//       </nonDerivativeTransaction>
//     </nonDerivativeTable>
//   </ownershipDocument>
function tagText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : '';
}
function tagValue(xml, tag) {
  // Extract <value>...</value> inside named tag
  const block = tagText(xml, tag);
  if (!block) return '';
  return tagText(block, 'value');
}

async function parseForm4(cik, accession, primaryDoc) {
  const cikUnpadded = String(parseInt(cik, 10));
  const accClean = accession.replace(/-/g, '');
  const baseUrl = `https://www.sec.gov/Archives/edgar/data/${cikUnpadded}/${accClean}`;
  if (!primaryDoc) return null;

  // 2026-05-19 BUG FIX: SEC's primaryDoc field often has 'xslF345X06/form4.xml'
  // which is the HTML-rendered view (no <ownershipDocument> tag). The raw XML
  // sits at the URL WITHOUT the xsl* prefix. Strip any xsl* path prefix to
  // get the actual XML form filing.
  const rawXmlName = primaryDoc.replace(/^xsl[A-Za-z0-9]+\//, '');
  let xml = null;
  try {
    xml = await secFetch(`${baseUrl}/${rawXmlName}`, 'text');
    if (!xml || !xml.includes('ownershipDocument')) {
      // Fallback: try original (in case the XSL strip was wrong)
      xml = await secFetch(`${baseUrl}/${primaryDoc}`, 'text');
      if (!xml || !xml.includes('ownershipDocument')) return null;
    }
  } catch (e) { return null; }

  // Insider name + title
  const ownerBlock = tagText(xml, 'reportingOwner');
  const insiderName = tagText(ownerBlock, 'rptOwnerName') || 'Unknown';
  const relBlock = tagText(ownerBlock, 'reportingOwnerRelationship');
  const isDirector = /<isDirector>\s*1\s*<\/isDirector>|<isDirector>\s*true/i.test(relBlock);
  const isOfficer  = /<isOfficer>\s*1\s*<\/isOfficer>|<isOfficer>\s*true/i.test(relBlock);
  const isTenPercent = /<isTenPercentOwner>\s*1\s*<\/isTenPercentOwner>/i.test(relBlock);
  const officerTitle = tagText(relBlock, 'officerTitle');
  let title = officerTitle || (isDirector ? 'Director' : '') || (isOfficer ? 'Officer' : '') || (isTenPercent ? '10% Owner' : '') || '—';

  // Walk non-derivative transactions, sum P (purchase) trades
  const txnBlocks = xml.match(/<nonDerivativeTransaction[^>]*>[\s\S]*?<\/nonDerivativeTransaction>/g) || [];
  const purchases = [];
  for (const txn of txnBlocks) {
    const code = tagValue(txn, 'transactionCode') || tagText(tagText(txn, 'transactionCoding'), 'transactionCode');
    if (code !== 'P') continue;
    const date    = tagValue(txn, 'transactionDate');
    const shares  = parseFloat(tagValue(txn, 'transactionShares')) || 0;
    const price   = parseFloat(tagValue(txn, 'transactionPricePerShare')) || 0;
    if (shares <= 0 || price <= 0) continue;
    purchases.push({
      insider: insiderName,
      title,
      date,
      shares,
      price,
      value: Math.round(shares * price),
    });
  }
  return purchases;
}

// ── Per-symbol aggregation ────────────────────────────────────────────────
async function scanSymbol(symbol, cik) {
  // 2026-05-19 (v2): 30s timeout. With single-fetch parseForm4 and no inner
  // DELAY, even tickers with 20 Form 4 filings should finish in <15s.
  return Promise.race([
    _scanSymbolImpl(symbol, cik),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 30s')), 30000)),
  ]).catch(() => null);
}

async function _scanSymbolImpl(symbol, cik) {
  try {
    const filings = await getRecentForm4Filings(cik);
    if (!filings.length) return null;

    // Parallel-fetch all filings for this ticker (Promise.all with bounded count
    // — getRecentForm4Filings already limits to last 30 days = typically <10)
    const settled = await Promise.allSettled(
      filings.map(f => parseForm4(cik, f.accession, f.primaryDoc))
    );
    const allPurchases = [];
    settled.forEach(r => {
      if (r.status === 'fulfilled' && r.value && r.value.length) {
        allPurchases.push(...r.value);
      }
    });
    if (!allPurchases.length) return null;

    const totalValue30d = allPurchases.reduce((s, p) => s + p.value, 0);
    const insiders = new Set(allPurchases.map(p => p.insider));
    const buyerCount30d = insiders.size;
    // Cluster: ≥2 insiders OR single insider > $100K
    const singleBigBuy = buyerCount30d === 1 && totalValue30d > 100000;
    const clusterBuy = buyerCount30d >= 2 || singleBigBuy;

    return {
      filings:       allPurchases.sort((a, b) => (b.date || '').localeCompare(a.date || '')),
      totalValue30d,
      buyerCount30d,
      clusterBuy,
    };
  } catch (e) {
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== Insider Buying Scan (SEC EDGAR Form 4) ===');
  console.log(`Start: ${new Date().toISOString()}`);

  // 1. Build target ticker list from latest scan output
  const scan = loadJSON('us_scan.json', null);
  if (!scan) { console.error('No us_scan.json found — run scan.js first'); return; }
  const leaders     = (scan.leaders     || []).map(r => r.symbol);
  const discoveries = (scan.discoveries || []).map(r => r.symbol);
  const targets     = [...new Set([...leaders, ...discoveries])].filter(s => /^[A-Z][A-Z0-9.]{0,4}$/.test(s));
  console.log(`  Targets: ${targets.length} symbols (${leaders.length} leaders + ${discoveries.length} discoveries)`);

  // 2. CIK map
  const cikMap = await loadCikMap();
  const withCik = targets.map(s => ({ symbol: s, cik: cikMap[s]?.cik })).filter(t => t.cik);
  console.log(`  CIK match: ${withCik.length}/${targets.length}`);

  // 3. Scan symbols in parallel batches. SEC limit is 10 req/sec — concurrency 5
  // keeps us comfortably under (each scanSymbol does ~2 SEC calls).
  // 2026-05-19: was sequential with 220ms delay = ~8s per ticker × 37 = 5 min,
  // sometimes hung on a single slow ticker pushing total > 10 min cancel.
  // Parallel batches of 5 = ~1.5-2 min total, immune to single-ticker hangs.
  const bySymbol = {};
  let hits = 0;
  const BATCH = 5;
  for (let i = 0; i < withCik.length; i += BATCH) {
    const slice = withCik.slice(i, i + BATCH);
    const results = await Promise.allSettled(slice.map(t => scanSymbol(t.symbol, t.cik)));
    results.forEach((r, j) => {
      const { symbol } = slice[j];
      const result = r.status === 'fulfilled' ? r.value : null;
      const idx = i + j + 1;
      if (result) {
        bySymbol[symbol] = result;
        hits += 1;
        const tag = result.clusterBuy ? '★ CLUSTER' : '·';
        console.log(`  [${idx}/${withCik.length}] ${symbol}: ${result.buyerCount30d} insider(s), $${(result.totalValue30d/1000).toFixed(0)}K ${tag}`);
      } else if (r.status === 'rejected') {
        console.log(`  [${idx}/${withCik.length}] ${symbol}: error (${(r.reason?.message || 'unknown').slice(0, 40)})`);
      } else {
        process.stdout.write(`  [${idx}/${withCik.length}] ${symbol}: no purchases       \r`);
      }
    });
    // Small breather between batches to stay polite to SEC
    if (i + BATCH < withCik.length) await DELAY(400);
  }

  // 4. Save
  const output = {
    generatedAt: Date.now(),
    scannedAt:   new Date().toISOString(),
    universeSize: targets.length,
    matched:     withCik.length,
    hits,
    bySymbol,
  };
  saveJSON('insider_data.json', output);
  console.log(`\nSaved → insider_data.json (${hits} symbols with insider purchases)`);
  console.log(`End: ${new Date().toISOString()}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
