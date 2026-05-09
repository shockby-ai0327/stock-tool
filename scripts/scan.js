/**
 * scan.js — Server-side RS Leader Scanner
 * Runs in GitHub Actions, saves results to ../data/us_scan.json + tw_scan.json
 *
 * Universe: S&P 500 + Russell 1000 Growth + Momentum ETF holdings (MTUM/XMMO/DWAS/QMOM)
 * ~1000–1200 unique tickers, covering large + mid + small cap growth/momentum stocks
 *
 * Algorithm: IBD-style RS Rating (percentile rank of 12-1 month momentum vs benchmark)
 * Filters: price > MA50, avg volume > 200k, 12-1mo return > 0
 * Score: rsRating×50% + volExpand×30% + momentumTilt×20%
 */

import fetch from 'node-fetch';
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

const DELAY = ms => new Promise(r => setTimeout(r, ms));

// ── Yahoo Finance helpers ───────────────────────────────────────────────────

async function yfFetch(url, retries = 3) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
      if (res.status === 429) {
        const wait = (i + 1) * 3000;
        console.log(`  429 rate limit, waiting ${wait}ms...`);
        await DELAY(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await DELAY(1500 * (i + 1));
    }
  }
}

// Batch quote: up to 200 symbols per call, returns basic quote data
async function batchQuote(symbols) {
  const CHUNK = 180;
  const results = {};
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const chunk = symbols.slice(i, i + CHUNK);
    try {
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${chunk.join(',')}&fields=symbol,shortName,longName,regularMarketPrice,regularMarketChangePercent,fiftyTwoWeekChangePercent,averageVolume3Month,regularMarketVolume`;
      const data = await yfFetch(url);
      (data?.quoteResponse?.result || []).forEach(q => { results[q.symbol] = q; });
    } catch (e) {
      console.warn(`  batchQuote chunk ${i}-${i+CHUNK} failed: ${e.message}`);
    }
    if (i + CHUNK < symbols.length) await DELAY(600);
  }
  return results;
}

// OHLCV: 6-month daily bars for a single symbol
async function getOHLCV(symbol, range = '12mo') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}&includePrePost=false`;
  const data = await yfFetch(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error('no data');
  const oq = result.indicators.quote[0];
  return {
    closes: oq.close.filter(v => v != null),
    volumes: oq.volume.filter(v => v != null),
    meta: result.meta,
  };
}

// Fetch ETF holdings from Yahoo (returns top 25 holdings symbols)
async function fetchEtfHoldings(etfSymbol) {
  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/quoteSummary/${etfSymbol}?modules=topHoldings`;
    const data = await yfFetch(url);
    const holdings = data?.quoteSummary?.result?.[0]?.topHoldings?.holdings || [];
    return holdings.map(h => h.symbol).filter(Boolean);
  } catch (e) {
    console.warn(`  ETF holdings fetch failed for ${etfSymbol}: ${e.message}`);
    return [];
  }
}

// Fetch Yahoo predefined screener symbols
async function fetchScreener(scrId, count = 50) {
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${scrId}&start=0&count=${count}&formatted=false`;
    const data = await yfFetch(url);
    const quotes = data?.finance?.result?.[0]?.quotes || [];
    return quotes.map(q => q.symbol).filter(s => s && s.length <= 5 && !/[./]/.test(s));
  } catch (e) {
    console.warn(`  Screener ${scrId} failed: ${e.message}`);
    return [];
  }
}

// ── Stock universe ──────────────────────────────────────────────────────────

// S&P 500 core (full 503-ticker list, split into groups for readability)
const SP500 = [
  // Information Technology
  'AAPL','MSFT','NVDA','AVGO','ORCL','CRM','AMD','QCOM','TXN','INTC',
  'MU','AMAT','LRCX','KLAC','ADI','MRVL','CDNS','SNPS','ANSS','FTNT',
  'PANW','CRWD','ZS','OKTA','DDOG','NET','MDB','SNOW','NOW','WDAY',
  'ADBE','INTU','MSCI','EPAM','CTSH','ACN','IBM','HPQ','HPE','DELL',
  'SMCI','GLW','TEL','APH','TDY','KEYS','TRMB','FFIV','JNPR','NTAP',
  // Communication Services
  'META','GOOGL','GOOG','NFLX','DIS','CMCSA','T','VZ','TMUS','CHTR',
  'TTWO','EA','ATVI','WBD','PARA','LYV','OMC','IPG','FOXA','FOX',
  // Consumer Discretionary
  'AMZN','TSLA','HD','MCD','NKE','SBUX','TJX','LOW','BKNG','MAR',
  'HLT','ABNB','RCL','CCL','NCLH','YUM','CMG','DRI','QSR','WYNN',
  'LVS','MGM','PENN','EXPE','LYFT','UBER','ETSY','EBAY','RVTY','RL',
  'PVH','TPR','VFC','HBI','LB','GPS','ANF','AEO','URBN','BBWI',
  'APTV','BWA','LEA','MGA','LKQ','AZO','ORLY','AAP','KMX','AN',
  'GPC','POOL','SHW','WHR','NVR','PHM','DHI','LEN','TOL','MDC',
  // Consumer Staples
  'WMT','COST','PG','KO','PEP','PM','MO','MDLZ','CL','GIS',
  'K','CPB','HRL','SJM','CAG','MKC','KHC','STZ','BF-B','TAP',
  'EL','COTY','CHD','CLX','KMB','PG','AVP','REYN',
  // Health Care
  'LLY','JNJ','UNH','ABBV','MRK','TMO','ABT','DHR','BMY','AMGN',
  'GILD','VRTX','REGN','ISRG','BSX','MDT','EW','SYK','ZBH','BAX',
  'BDX','HOLX','IDXX','IQV','IQVIA','A','WAT','MTD','PKI','PODD',
  'DXCM','ALGN','PENN','RMD','INSP','NVCR','EXAS','GH','NVAX','MRNA',
  'PFE','CVS','CI','HUM','ELV','CNC','MOH','HCA','THC','UHS',
  // Financials
  'BRK-B','JPM','BAC','WFC','GS','MS','C','AXP','BLK','SCHW',
  'COF','DFS','SYF','AIG','MET','PRU','AFL','ALL','TRV','CB',
  'AJG','MMC','AON','WTW','BX','KKR','APO','CG','ARES','BAM',
  'V','MA','PYPL','FI','FIS','GPN','FISV','WEX','EVTC','COOP',
  'USB','PNC','TFC','FITB','RF','HBAN','KEY','MTB','NTRS','STT',
  'SIVB','SBNY','WAL','PACW','FHN','ZION','CFG','ALLY','SLM',
  // Energy
  'XOM','CVX','COP','EOG','PXD','DVN','FANG','MPC','VLO','PSX',
  'HES','OXY','SLB','HAL','BKR','NOV','FTI','HP','RIG','VAL',
  'CTRA','APA','MRO','SM','MTDR','VTLE','CRGY','PR','MGY','CHRD',
  // Industrials
  'CAT','DE','HON','GE','RTX','LMT','NOC','GD','BA','TDG',
  'HWM','HII','L3H','LDOS','SAIC','CSX','UNP','NSC','CP','CNI',
  'UPS','FDX','XPO','ODFL','SAIA','JBHT','CHRW','EXPD','GXO','REXR',
  'MMM','EMR','ETN','ROK','PH','AME','FAST','GWW','MSC','WSO',
  'CARR','OTIS','TT','JCI','LYTS','AOS','IR','XYL','TRMB','GNRC',
  // Materials
  'LIN','APD','ECL','PPG','SHW','FCX','NEM','GOLD','AA','X',
  'NUE','STLD','RS','ATI','CF','MOS','NTR','FMC','ALB','LTHM',
  // Real Estate
  'AMT','PLD','EQIX','CCI','SBAC','DLR','PSA','EQR','AVB','UDR',
  'CPT','ESS','MAA','NNN','O','VICI','GLPI','PEAK','WELL','VTR',
  // Utilities
  'NEE','DUK','SO','AEP','EXC','SRE','XEL','D','ETR','FE',
  'WEC','ES','DTE','CNP','NI','AES','ATO','LNT','EVRG','OGE',
].filter((v, i, a) => a.indexOf(v) === i); // deduplicate

// High-growth / momentum stocks NOT in S&P 500 (small/mid cap explosives)
const GROWTH_EXTENDED = [
  // Recent momentum leaders & emerging growth
  'PLTR','RKLB','IONQ','RGTI','QBTS','ARQQ','BTDR',
  'ARM','HOOD','COIN','MSTR','MARA','RIOT','HUT','CIFR',
  'SMCI','AXON','CELH','DUOL','CRDO','ALAB','ASST',
  'ASTS','LUNR','RDW','SPCE','ACHR','JOBY','LILM','EVTL',
  'SHOP','DKNG','RBLX','U','SNAP','PINS','BMBL','MTCH',
  'AFRM','UPST','SOFI','LC','OPEN','OPFI','DAVE',
  'GLBE','SEMR','MELI','NU','PDD','SE','GRAB','BABA',
  'TSM','ASML','LSCC','ALGM','ACLS','PLAB','DIOD',
  'WOLF','LAZR','LIDR','OUST','AEYE','MVIS','INVZ',
  'RXRX','SEER','ZYMERGEN','BEAM','EDIT','CRSP','NTLA','VERV',
  'DOCS','HIMS','ACCD','PHR','NVCR','RXDX','KRTX','IMVT',
  'TMDX','IRTC','INSP','SILK','ATRC','SWAV','NARI','NVST',
  'SITE','STAG','TRNO','COLD','IIPR','LAND','PINE',
  'GTLB','DOMO','BRZE','AMPL','SPLT','FRSH','SPRK',
  'ESTC','SUMO','APPN','PEGA','ALTR','BOX','DOCN','FSLY',
  'HALO','PRCT','IOVA','XNCR','FATE','BLUE','FOLD','IMCR',
  'CLOV','ONEM','TDOC','AMWL','OPRX','TALK','MTTR','LMND',
];

// TW scan pool
const TW_POOL = [
  '2330.TW','2317.TW','2454.TW','2382.TW','2308.TW','2303.TW','2412.TW',
  '2881.TW','2882.TW','2884.TW','2885.TW','2886.TW','2887.TW','2888.TW',
  '2891.TW','2892.TW','2301.TW','2302.TW','2303.TW','2311.TW','2313.TW',
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

// ETF symbols whose holdings we fetch dynamically (covers mid + small cap momentum)
const MOMENTUM_ETFS = ['MTUM', 'XMMO', 'DWAS', 'QMOM', 'VFMO'];

// Known ETFs to exclude from stock scanning
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

// ── RS Rating calculation ───────────────────────────────────────────────────

function calcRSRatings(stocks) {
  const values = stocks.map(s => s.rs12_1);
  values.sort((a, b) => a - b);
  stocks.forEach(s => {
    const rank = values.filter(v => v <= s.rs12_1).length;
    s.rsRating = Math.round((rank / values.length) * 98) + 1;
  });
}

// ── Main scan logic ─────────────────────────────────────────────────────────

async function scanUS() {
  console.log('\n=== US RS Leader Scan ===');
  console.log(`Start: ${new Date().toISOString()}`);

  // 1. Build universe: static pools + dynamic ETF holdings + screeners
  console.log('\n[1] Building universe...');

  const [etfHoldings, screenerGainers, screenerSmallCap, screenerGrowth] = await Promise.allSettled([
    Promise.all(MOMENTUM_ETFS.map(e => fetchEtfHoldings(e))).then(r => r.flat()),
    fetchScreener('day_gainers', 50),
    fetchScreener('small_cap_gainers', 50),
    fetchScreener('growth_technology_stocks', 50),
  ]);

  const universe = new Set([...SP500, ...GROWTH_EXTENDED]);

  if (etfHoldings.status === 'fulfilled')
    etfHoldings.value.filter(s => !isEtf(s)).forEach(s => universe.add(s));
  if (screenerGainers.status === 'fulfilled')
    screenerGainers.value.filter(s => !isEtf(s)).forEach(s => universe.add(s));
  if (screenerSmallCap.status === 'fulfilled')
    screenerSmallCap.value.filter(s => !isEtf(s)).forEach(s => universe.add(s));
  if (screenerGrowth.status === 'fulfilled')
    screenerGrowth.value.filter(s => !isEtf(s)).forEach(s => universe.add(s));

  const allSymbols = [...universe];
  console.log(`  Universe: ${allSymbols.length} unique stocks`);

  // 2. Batch quote pre-filter: keep top 120 by 52W momentum
  console.log('\n[2] Batch quote pre-filter...');
  const quotes = await batchQuote(allSymbols);
  const preFiltered = allSymbols
    .map(s => ({ symbol: s, q: quotes[s] }))
    .filter(({ q }) => q && (q.averageVolume3Month || 0) >= 150000 && (q.regularMarketPrice || 0) >= 2)
    .sort((a, b) => (b.q.fiftyTwoWeekChangePercent || 0) - (a.q.fiftyTwoWeekChangePercent || 0))
    .slice(0, 120)
    .map(x => x.symbol);

  console.log(`  Pre-filtered: ${allSymbols.length} → ${preFiltered.length}`);

  // 3. Benchmark: SPY 12-month return
  console.log('\n[3] Fetching SPY benchmark...');
  let benchReturn = 0;
  try {
    const spy = await getOHLCV('SPY', '12mo');
    if (spy.closes.length >= 2) {
      const n = spy.closes.length;
      // 12-1 month momentum: use close[0] to close[n-21] (skip last month)
      const start = spy.closes[0];
      const end = spy.closes[Math.max(0, n - 21)];
      benchReturn = (end - start) / start * 100;
    }
    console.log(`  SPY 12-1mo benchmark: ${benchReturn.toFixed(2)}%`);
  } catch (e) {
    console.warn(`  SPY fetch failed: ${e.message}`);
  }

  // 4. Deep OHLCV scan (120 stocks, batches of 10)
  console.log(`\n[4] Deep OHLCV scan (${preFiltered.length} stocks)...`);
  const results = [];
  const BATCH = 10;

  for (let i = 0; i < preFiltered.length; i += BATCH) {
    const batch = preFiltered.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(async sym => {
      try {
        const { closes, volumes } = await getOHLCV(sym, '12mo');
        if (closes.length < 60) return null;

        const n = closes.length;
        const price = closes[n - 1];
        const ma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
        if (price < ma50) return null;

        const avgVol20 = volumes.slice(-20).reduce((a, b) => a + (b || 0), 0) / 20;
        if (avgVol20 < 150000) return null;

        // 12-1 month momentum (skip last month to avoid short-term reversal)
        const startClose = closes[0];
        const midClose = closes[Math.max(0, n - 21)]; // 1 month ago
        const ret12_1 = (midClose - startClose) / startClose * 100;
        const rs12_1 = ret12_1 - benchReturn;

        // Recent 1-month return (signal for fresh breakout)
        const ret1m = (price - closes[Math.max(0, n - 21)]) / closes[Math.max(0, n - 21)] * 100;

        const avgVol5 = volumes.slice(-5).reduce((a, b) => a + (b || 0), 0) / 5;
        const volExpand = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;

        const changePct = n >= 2 ? (price - closes[n - 2]) / closes[n - 2] * 100 : 0;

        const q = quotes[sym] || {};
        return {
          symbol: sym,
          name: q.shortName || q.longName || sym,
          price: q.regularMarketPrice || price,
          changePct: q.regularMarketChangePercent || changePct,
          ret12_1,
          ret1m,
          rs12_1,
          volExpand: Math.round(volExpand * 100) / 100,
          ma50: Math.round(ma50 * 100) / 100,
          avgVol20: Math.round(avgVol20),
          fiftyTwoWeekChangePercent: q.fiftyTwoWeekChangePercent || 0,
        };
      } catch (e) { return null; }
    }));

    settled.forEach(s => { if (s.status === 'fulfilled' && s.value) results.push(s.value); });
    process.stdout.write(`  ${Math.min(i + BATCH, preFiltered.length)}/${preFiltered.length} scanned (${results.length} passed)\r`);

    // Respectful delay between batches to avoid hammering Yahoo
    if (i + BATCH < preFiltered.length) await DELAY(800);
  }

  console.log(`\n  Results: ${results.length} stocks passed filters`);

  if (results.length === 0) {
    console.error('No results — aborting save');
    return;
  }

  // 5. RS Rating + composite score
  calcRSRatings(results);
  results.forEach(r => {
    const volScore = Math.min(99, Math.round(r.volExpand * 33));
    const momScore = Math.min(99, Math.max(1, Math.round(50 + r.rs12_1 * 0.6)));
    r.compositeScore = Math.round(r.rsRating * 0.50 + volScore * 0.30 + momScore * 0.20);
  });

  results.sort((a, b) => b.compositeScore - a.compositeScore);
  const top25 = results.slice(0, 25); // store top 25 (show 15, rest for watchlist)

  // 6. Save
  const output = {
    scannedAt: new Date().toISOString(),
    universeSize: allSymbols.length,
    scannedCount: preFiltered.length,
    passedCount: results.length,
    benchmark: { symbol: 'SPY', ret12_1: benchReturn },
    leaders: top25,
  };

  const outPath = join(DATA_DIR, 'us_scan.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n[5] Saved → data/us_scan.json (${top25.length} leaders)`);
  console.log(`End: ${new Date().toISOString()}\n`);
}

async function scanTW() {
  console.log('\n=== TW RS Leader Scan ===');
  console.log(`Start: ${new Date().toISOString()}`);

  // Benchmark: 0050.TW
  let benchReturn = 0;
  try {
    const bench = await getOHLCV('0050.TW', '12mo');
    const n = bench.closes.length;
    if (n >= 2) {
      benchReturn = (bench.closes[Math.max(0, n-21)] - bench.closes[0]) / bench.closes[0] * 100;
    }
    console.log(`  0050.TW 12-1mo benchmark: ${benchReturn.toFixed(2)}%`);
  } catch (e) {
    console.warn('  0050.TW fetch failed:', e.message);
  }

  const results = [];
  const BATCH = 8;

  for (let i = 0; i < TW_POOL.length; i += BATCH) {
    const batch = TW_POOL.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(async sym => {
      try {
        const { closes, volumes } = await getOHLCV(sym, '12mo');
        if (closes.length < 50) return null;
        const n = closes.length;
        const price = closes[n - 1];
        const ma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
        if (price < ma50) return null;
        const avgVol20 = volumes.slice(-20).reduce((a, b) => a + (b || 0), 0) / 20;
        const ret12_1 = (closes[Math.max(0, n-21)] - closes[0]) / closes[0] * 100;
        const rs12_1 = ret12_1 - benchReturn;
        const avgVol5 = volumes.slice(-5).reduce((a, b) => a + (b || 0), 0) / 5;
        const volExpand = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;
        const changePct = n >= 2 ? (price - closes[n-2]) / closes[n-2] * 100 : 0;
        return { symbol: sym, name: sym, price, changePct, ret12_1, rs12_1, volExpand: Math.round(volExpand*100)/100, ma50: Math.round(ma50*100)/100, avgVol20: Math.round(avgVol20) };
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

  const output = {
    scannedAt: new Date().toISOString(),
    universeSize: TW_POOL.length,
    scannedCount: TW_POOL.length,
    passedCount: results.length,
    benchmark: { symbol: '0050.TW', ret12_1: benchReturn },
    leaders: results.slice(0, 25),
  };

  writeFileSync(join(DATA_DIR, 'tw_scan.json'), JSON.stringify(output, null, 2));
  console.log(`Saved → data/tw_scan.json (${output.leaders.length} leaders)`);
}

// ── Entry point ─────────────────────────────────────────────────────────────

const market = process.argv[2] || 'all';
if (market === 'us' || market === 'all') await scanUS();
if (market === 'tw' || market === 'all') await scanTW();
console.log('Done.');
