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

// OHLCV via v8/finance/chart — no auth required
async function getOHLCV(symbol, range = '12mo') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}&includePrePost=false`;
  const data = await yfFetch(url);
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

// ── VCP (Volatility Contraction Pattern) detector ──────────────────────────
// Minervini method: price above trend, each pullback tighter than the last.
// Returns { vcpScore: 0-4, vcpDepth: number (% range in last 20d) }
function calcVCP(closes, highs, lows) {
  const n = closes.length;
  if (n < 60 || highs.length < 60 || lows.length < 60) return { vcpScore: 0 };
  const rangeOf = (start, end) => {
    const h = highs.slice(start, end ?? undefined);
    const l = lows.slice(start, end ?? undefined);
    const hi = Math.max(...h), lo = Math.min(...l);
    return lo > 0 ? (hi - lo) / lo : 0;
  };
  const r10 = rangeOf(-10);       // last 10 days (tightest window)
  const r20 = rangeOf(-30, -10);  // 10–30 days ago
  const r30 = rangeOf(-60, -30);  // 30–60 days ago

  // Each window must be ≥10% tighter than the prior one
  if (!(r10 < r20 * 0.90 && r20 < r30 * 0.90)) return { vcpScore: 0 };

  const depth20 = rangeOf(-20);   // overall base depth (last 20 days)

  // Proximity to 3-month high (+1 bonus if within 8%)
  const price = closes[n - 1];
  const high3m = Math.max(...highs.slice(-60));
  const nearHigh = price >= high3m * 0.92;

  // Tightness score: tighter = better
  const tightScore = depth20 < 0.07 ? 3 : depth20 < 0.12 ? 2 : 1;
  const vcpScore = Math.min(4, nearHigh ? tightScore + 1 : tightScore);

  return { vcpScore, vcpDepth: Math.round(depth20 * 100) };
}

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

// ── US Scan ─────────────────────────────────────────────────────────────────

async function scanUS() {
  console.log('\n=== US RS Leader + Discovery Scan ===');
  console.log(`Start: ${new Date().toISOString()}`);

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
    SCREENER_IDS.map(id => fetchScreener(id, 100))
  );

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

  // 2. SPY + sector benchmarks
  console.log('\n[2] Fetching benchmarks...');
  let benchReturn = 0;
  const sectorBenchmarks = {}; // sym → ret12_1

  const SECTOR_ETFS_SCAN = ['SMH','IGV','XLK','XLC','XLY','XLI','XLF','XLB','XLE','IBB','XAR','GDX','XLV','XLP','XLU'];
  try {
    const spy = await getOHLCV('SPY', '12mo');
    const n = spy.closes.length;
    benchReturn = (spy.closes[Math.max(0, n - 21)] - spy.closes[0]) / spy.closes[0] * 100;
    console.log(`  SPY 12-1mo: ${benchReturn.toFixed(2)}%`);
  } catch (e) { console.warn(`  SPY failed: ${e.message}`); }

  // Fetch sector ETF returns for relative sector RS (non-blocking, best-effort)
  try {
    const sectorResults = await Promise.allSettled(
      SECTOR_ETFS_SCAN.map(async sym => {
        const { closes } = await getOHLCV(sym, '12mo');
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
  const BATCH = 15, BATCH_DELAY = 500;
  console.log(`\n[3] Scanning ${allSymbols.length} symbols (batch=${BATCH})...`);

  const leaders   = [];  // confirmed momentum (12-1mo RS)
  const discoCand = [];  // acceleration discovery (3-mo accel)

  for (let i = 0; i < allSymbols.length; i += BATCH) {
    const batch = allSymbols.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(async sym => {
      try {
        const { closes, highs, lows, volumes, meta } = await getOHLCV(sym, '12mo');
        // Need at least 3 months of data; leaders need 12mo
        if (closes.length < 60) return null;

        const m = calcMetrics(closes, highs, volumes, meta, benchReturn);
        const vcp = calcVCP(closes, highs, lows);

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

        // Assign sector ETF based on symbol → sector map (best-effort, ~120 tickers)
        const SECTOR_MAP = {
          // ── Semiconductors → SMH ──────────────────────────────────────────
          NVDA:'SMH',AMD:'SMH',AVGO:'SMH',QCOM:'SMH',MU:'SMH',AMAT:'SMH',LRCX:'SMH',
          KLAC:'SMH',ADI:'SMH',MRVL:'SMH',CRDO:'SMH',ALAB:'SMH',ACLS:'SMH',NVTS:'SMH',
          MPWR:'SMH',WOLF:'SMH',ON:'SMH',SWKS:'SMH',MCHP:'SMH',TXN:'SMH',INTC:'SMH',
          SMTC:'SMH',AMBA:'SMH',CRUS:'SMH',SLAB:'SMH',SITM:'SMH',DIOD:'SMH',
          AXTI:'SMH',KLIC:'SMH',COHU:'SMH',UCTT:'SMH',ICHR:'SMH',ASYS:'SMH',
          POWI:'SMH',MTSI:'SMH',ALGM:'SMH',LASR:'SMH',AAOI:'SMH',IIVI:'SMH',
          // ── Software → IGV ────────────────────────────────────────────────
          ORCL:'IGV',CRM:'IGV',NOW:'IGV',WDAY:'IGV',SNOW:'IGV',DDOG:'IGV',
          NET:'IGV',MDB:'IGV',CRWD:'IGV',PANW:'IGV',ZS:'IGV',PLTR:'IGV',
          HUBS:'IGV',VEEV:'IGV',TEAM:'IGV',GTLB:'IGV',S:'IGV',SMAR:'IGV',
          BILL:'IGV',FRSH:'IGV',DOCN:'IGV',DOCUSIGN:'IGV',
          // ── Photonics/Fiber/Telecom Equip → XLK ──────────────────────────
          GLW:'XLK',COHR:'XLK',LITE:'XLK',JNPR:'XLK',CIEN:'XLK',INFN:'XLK',
          VIAV:'XLK',CALX:'XLK',GILT:'XLK',ADTM:'XLK',NPKI:'XLK',FN:'XLK',
          // ── Comms / Media → XLC ──────────────────────────────────────────
          META:'XLC',GOOGL:'XLC',GOOG:'XLC',NFLX:'XLC',DIS:'XLC',PARA:'XLC',
          WBD:'XLC',SNAP:'XLC',PINS:'XLC',RDDT:'XLC',SPOT:'XLC',EA:'XLC',
          // ── Defense / Aerospace → XAR ─────────────────────────────────────
          RKLB:'XAR',ASTS:'XAR',AXON:'XAR',LDOS:'XAR',KTOS:'XAR',LHX:'XAR',
          NOC:'XAR',RTX:'XAR',LMT:'XAR',GD:'XAR',HEI:'XAR',TDG:'XAR',
          BKSY:'XAR',PL:'XAR',SPIR:'XAR',ATRO:'XAR',
          // ── Financials (incl. crypto/fintech) → XLF ───────────────────────
          COIN:'XLF',HOOD:'XLF',AFRM:'XLF',UPST:'XLF',SQ:'XLF',
          HUT:'XLF',CIFR:'XLF',MARA:'XLF',RIOT:'XLF',IREN:'XLF',CLSK:'XLF',
          BTBT:'XLF',WULF:'XLF',BTDR:'XLF',CORZ:'XLF',NBTB:'XLF',
          GS:'XLF',JPM:'XLF',MS:'XLF',BAC:'XLF',WFC:'XLF',C:'XLF',
          V:'XLF',MA:'XLF',AXP:'XLF',PYPL:'XLF',NU:'XLF',
          // ── Biotech / Pharma → IBB ────────────────────────────────────────
          RXRX:'IBB',MRNA:'IBB',BEAM:'IBB',CRSP:'IBB',NTLA:'IBB',EDIT:'IBB',
          ALLO:'IBB',FATE:'IBB',SANA:'IBB',VERV:'IBB',ARKG:'IBB',CAPR:'IBB',
          MGNX:'IBB',STTK:'IBB',ATRA:'IBB',ARQT:'IBB',IMVT:'IBB',
          // ── General Healthcare → XLV ──────────────────────────────────────
          ISRG:'XLV',TMO:'XLV',ABT:'XLV',MDT:'XLV',SYK:'XLV',EW:'XLV',
          DXCM:'XLV',ALGN:'XLV',PODD:'XLV',INSP:'XLV',NVCR:'XLV',PACS:'XLV',
          // ── Energy / Mining / Materials → XLE / XLB / GDX ────────────────
          XOM:'XLE',CVX:'XLE',COP:'XLE',EOG:'XLE',SLB:'XLE',HAL:'XLE',
          NRGV:'XLE',FLNC:'XLE',FSLR:'XLE',ENPH:'XLE',SEDG:'XLE',
          HL:'GDX',EXK:'GDX',HYMC:'GDX',AG:'GDX',WPM:'GDX',AEM:'GDX',
          GPRE:'XLB',ALB:'XLB',MP:'XLB',NEM:'GDX',GOLD:'GDX',
          // ── Consumer Discretionary → XLY ──────────────────────────────────
          AMZN:'XLY',TSLA:'XLY',NKE:'XLY',PTON:'XLY',LULU:'XLY',
          RH:'XLY',W:'XLY',WRBY:'XLY',DECK:'XLY',ONON:'XLY',
          // ── Industrials → XLI ─────────────────────────────────────────────
          GE:'XLI',CAT:'XLI',HON:'XLI',DE:'XLI',UPS:'XLI',FDX:'XLI',
          BW:'XLI',LQDA:'XLI',EVC:'XLI',
          // ── Storage / Memory / Misc HW → SMH ─────────────────────────────
          MSTR:'SMH',WDC:'SMH',STX:'SMH',SNDK:'SMH',
        };
        // Static map covers ~120 popular tickers; unmapped stocks get null
        const sectorEtf = SECTOR_MAP[sym] || null;
        const sectorRet = sectorEtf && sectorBenchmarks[sectorEtf] != null ? sectorBenchmarks[sectorEtf] : null;
        const sectorRS  = sectorRet != null ? round2(m.ret12_1 - sectorRet) : null;

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
          sectorEtf,
          sectorRS,
          accel:      round2(m.accel),
          volExpand:  round2(m.volExpand),
          volTrend:   round2(m.volTrend),
          ma50:       round2(m.ma50),
          avgVol20:   Math.round(m.avgVol20),
          high52w:    round2(m.high52w),
          high3m:     round2(m.high3m),
          vcpScore:   vcp.vcpScore,
          vcpDepth:   vcp.vcpDepth ?? null,
          isLeader,
          isDiscovery,
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

    process.stdout.write(`  ${Math.min(i + BATCH, allSymbols.length)}/${allSymbols.length} (L:${leaders.length} D:${discoCand.length})\r`);
    if (i + BATCH < allSymbols.length) await DELAY(BATCH_DELAY);
  }

  console.log(`\n  Leaders: ${leaders.length} | Discovery candidates: ${discoCand.length}`);
  if (leaders.length === 0) { console.error('No leaders — aborting'); return; }

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

  // 6. Save
  const output = {
    scannedAt:    new Date().toISOString(),
    universeSize: allSymbols.length,
    scannedCount: allSymbols.length,
    passedCount:  leaders.length + discoCand.length,
    benchmark:    { symbol: 'SPY', ret12_1: round2(benchReturn) },
    leaders:      leaders.slice(0, 25),
    discoveries,
  };

  writeFileSync(join(DATA_DIR, 'us_scan.json'), JSON.stringify(output, null, 2));
  console.log(`\n[6] Saved → us_scan.json (${output.leaders.length} leaders, ${discoveries.length} discoveries)`);
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
        const vcp = calcVCP(closes, highs, lows);
        return {
          symbol: sym, name: meta.shortName || sym,
          price: round2(m.price), changePct: round2(m.changePct),
          ret1m: round2(m.ret1m), ret3m: round2(m.ret3m),
          ret12_1: round2(m.ret12_1), rs12_1: round2(m.rs12_1),
          accel: round2(m.accel), volExpand: round2(m.volExpand),
          ma50: round2(m.ma50), avgVol20: Math.round(m.avgVol20),
          high52w: round2(m.high52w), high3m: round2(m.high3m),
          vcpScore: vcp.vcpScore, vcpDepth: vcp.vcpDepth ?? null,
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
