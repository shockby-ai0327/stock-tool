# 短線功能深化：完整實作指令

## 背景

你要修改的檔案是 `/Users/rich/Desktop/ai/smart-stock-source.html`，這是一個 2332 行的單一 HTML 檔案（HTML+CSS+JS 全部內嵌），部署在 GitHub Pages。**所有修改都在這一個檔案中完成。**

### 現有架構重點

- **CORS Proxy**：`PROXIES` 陣列（L228-232），透過 `pFetch()` 函式（L311-332）輪替 proxy
- **Yahoo Finance API**：`yfChart()` 拉 OHLCV（L338-345），`yfPageFundamentals()` 爬網頁基本面（L347-362）
- **即時報價**：`quickPrice()` 透過 5m interval 取最新價（L437-453）
- **批量報價**：`multiChart()` 分批抓多檔報價（L475-494）
- **技術指標函式庫**（L1232-1239）：`sma()`, `emaArr()`, `rsi()`, `bollinger()`, `stoch()`, `calcATR()`, `avg()`
- **技術分析引擎**：`technicalAnalysis()`（L598-631）產出 score -100~+100
- **導航系統**：`PAGES` 陣列 + `showPage()` 函式（L497-513），sidebar + mobile-nav 雙層導航
- **自動刷新**：`startAutoRefresh()` 每 180 秒（L2282-2298）
- **時間框架切換**：`_chgTF` + `switchTF()` + `calcChange()`（L406-433）
- **熱力圖股票清單**：`HEATMAP_STOCKS`（L2063-2155），美股 ~120 檔，台股 ~100 檔
- **K 線圖**：使用 Lightweight Charts v4.1.0（`renderKline()` L567-595）
- **localStorage**：交易日誌用 `stock-journal` key 儲存

---

## 需要新增的 7 個模組

### 導航結構變更

將 `PAGES` 陣列從：
```js
['stock', 'indices', 'sentiment', 'news', 'journal', 'calc', 'industry', 'heatmap']
```
改為：
```js
['stock', 'indices', 'sentiment', 'scanner', 'news', 'journal', 'risk', 'performance', 'calc', 'industry', 'heatmap', 'education']
```

在 sidebar `<nav>` 和 `#mobile-nav` 中新增 4 個按鈕：
- `📡 掃描器` → `showPage('scanner')`（放在 sentiment 後面）
- `🛡️ 風控中心` → `showPage('risk')`（放在 journal 後面）
- `📊 績效分析` → `showPage('performance')`（放在 risk 後面）
- `📚 短線教學` → `showPage('education')`（放在 heatmap 後面）

在 `showPage()` 函式中新增對應的初始化呼叫：
```js
if (name === 'scanner') loadScanner();
if (name === 'risk') renderRisk();
if (name === 'performance') renderPerformance();
if (name === 'education') renderEducation();
```

在 `.main` div 內新增 4 個 page div：
```html
<div id="page-scanner" class="page">...</div>
<div id="page-risk" class="page">...</div>
<div id="page-performance" class="page">...</div>
<div id="page-education" class="page">...</div>
```

---

## 模組 A：短線掃描器（含即時監控）

### 頁面結構

```html
<div id="page-scanner" class="page">
  <h2 style="margin-bottom:20px">📡 短線掃描器</h2>
  
  <!-- 市場選擇 -->
  <div class="tab-bar" id="scanner-market-tabs">
    <button class="active" onclick="switchScannerMarket('us')">🇺🇸 美股</button>
    <button onclick="switchScannerMarket('tw')">🇹🇼 台股</button>
  </div>
  
  <!-- 掃描策略選擇 -->
  <div class="tab-bar" id="scanner-tabs">
    <button class="active" onclick="runScan('momentum')">🚀 動量突破</button>
    <button onclick="runScan('oversold')">📉 超賣反彈</button>
    <button onclick="runScan('macd')">📊 MACD翻多</button>
    <button onclick="runScan('volume')">📢 放量異動</button>
    <button onclick="runScan('trend')">📈 均線多排</button>
    <button onclick="runScan('dip')">💎 跌深股</button>
  </div>
  
  <!-- 掃描結果 -->
  <div class="card" id="scanner-results">
    <h3>掃描結果</h3>
    <div id="scanner-table"></div>
  </div>
  
  <!-- 今日標的（即時監控） -->
  <div class="card" id="scanner-watchlist" style="border:2px solid var(--accent)">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3>⚡ 今日標的（即時監控中）</h3>
      <span id="scanner-market-status"></span>
    </div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:12px">
      ⚠️ 數據延遲約 15-20 秒，適合 15 分鐘以上級別的交易決策
    </div>
    <div id="watchlist-cards"></div>
    <div id="watchlist-empty" style="text-align:center;padding:30px;color:var(--muted)">
      從上方掃描結果點擊 [+] 加入今日標的
    </div>
  </div>
</div>
```

### 股票池設計

#### S&P 500 完整清單（Fallback + 美股掃描池）

新增全域變數 `SP500_TICKERS`，包含完整 S&P 500 成分股。這個清單有約 500 檔股票。

```js
const SP500_TICKERS = [
  'AAPL','MSFT','NVDA','AMZN','GOOGL','GOOG','META','BRK-B','LLY','AVGO',
  'JPM','TSLA','UNH','V','XOM','MA','PG','COST','JNJ','HD',
  'ABBV','WMT','NFLX','MRK','BAC','CRM','ORCL','AMD','CVX','KO',
  'PEP','ADBE','TMO','LIN','ACN','MCD','CSCO','ABT','WFC','GE',
  'IBM','DHR','PM','NOW','TXN','INTU','QCOM','ISRG','CAT','AMGN',
  'VZ','AMAT','GS','BKNG','SPGI','T','BLK','AXP','CMCSA','NEE',
  'PFE','BA','LOW','RTX','DE','HON','COP','LRCX','UBER','MS',
  'SYK','BMY','SCHW','REGN','ELV','MDLZ','VRTX','ETN','KLAC','CB',
  'ADI','CI','MU','SO','GILD','PGR','BSX','DUK','SNPS','CDNS',
  'BDX','FI','SHW','CME','ICE','ZTS','PYPL','MCO','CL','MMC',
  'EOG','APD','MO','ITW','NOC','SLB','ANET','TDG','WM','GD',
  'TGT','EMR','MCHP','CTAS','FDX','NXPI','PCAR','PH','ADP','ECL',
  'RCL','AIG','GM','AJG','CEG','F','TT','AFL','PSA','HCA',
  'TFC','MPC','SPG','NEM','SRE','USB','AEP','LHX','ORLY','D',
  'OKE','CCI','DLR','MNST','KMB','IDXX','AZO','FAST','GEHC','ROP',
  'A','GIS','YUM','HUM','CTVA','PRU','BKR','FICO','MSCI','VRSK',
  'GPN','ALL','KR','EW','OTIS','HSY','HPQ','DVN','PAYX','KVUE',
  'MLM','STZ','ODFL','PEG','EXC','AMP','AWK','VMC','XEL','DD',
  'NUE','WEC','ED','DOW','DTE','PPG','ACGL','EXR','AXON','CPAY',
  'IR','CTSH','CARR','NKE','SBUX','BIIB','DAL','HLT','MTD','WST',
  'BRO','FANG','CBRE','CDW','TRGP','HPE','IQV','TSN','NDAQ','AVB',
  'K','WTW','LUV','NTRS','MTB','FITB','HBAN','RF','CFG','KEY',
  'PLTR','CRWD','PANW','DDOG','ZS','SNOW','NET','WDAY','MDB','FTNT',
  'COIN','HOOD','AI','RKLB','IONQ','ARM','MRVL','ON','SMCI','DELL'
];
```

**注意**：以上只是示範結構，實際實作時請用網路上可查到的最新 S&P 500 成分股完整清單。數量應在 500 檔左右。最後加上一些熱門非 S&P 500 的股票（如 PLTR, CRWD, SMCI, DELL, COIN, RKLB, IONQ 等，約 20-30 檔額外熱門股）。

#### 台股核心清單

台股直接使用現有的 `HEATMAP_STOCKS.tw` 清單（約 100 檔），再額外新增以下至 300 檔：

```js
const TW_SCAN_EXTRA = [
  // 按市值排序的上市櫃補充股
  // 半導體補充
  '2344.TW','6005.TW','3029.TW','8150.TW','6278.TW','3105.TW','4966.TW','3035.TW',
  '6515.TW','3131.TW','8261.TW','2436.TW','3380.TW',
  // 電子補充
  '2354.TW','3706.TW','2324.TW','2347.TW','3023.TW','6285.TW','2360.TW',
  '2376.TW','3044.TW','6239.TW','2352.TW','3702.TW','3532.TW',
  // 傳產補充
  '1590.TW','2207.TW','9910.TW','2542.TW','2548.TW','5534.TW',
  '9921.TW','1210.TW','1215.TW','1227.TW','1232.TW','1718.TW',
  // 金融補充
  '2834.TW','2851.TW','2888.TW','2889.TW','2897.TW',
  // 生技補充
  '4162.TW','4736.TW','4107.TW','6589.TW','1565.TW','8436.TW',
  // 更多依市值排序的台股（這裡只是示範，實際請補齊到約 300 檔）
];

const TW_SCAN_POOL = [...new Set([
  ...HEATMAP_STOCKS.tw.map(s => s.t),
  ...TW_SCAN_EXTRA
])];
```

**實際實作要求**：台股掃描池至少需要 200 檔以上股票。以台灣上市公司按市值排序取前 200 檔 + 上櫃熱門 100 檔。每個代號格式為 `XXXX.TW`（上市）或 `XXXX.TWO`（上櫃）。

#### Yahoo Screener API 嘗試（美股優先使用）

```js
async function yahooScreener(params) {
  // Yahoo Finance screener endpoint
  // params: { dayChangePercent, volumeAboveAvg, marketCap, etc. }
  try {
    const body = {
      offset: 0,
      size: 50,
      sortField: 'dayvolume',
      sortType: 'desc',
      quoteType: 'equity',
      query: {
        operator: 'and',
        operands: []
      }
    };
    
    if (params.minDayChangePct != null) {
      body.query.operands.push({
        operator: 'gt',
        operands: ['percentchange', params.minDayChangePct]
      });
    }
    if (params.maxDayChangePct != null) {
      body.query.operands.push({
        operator: 'lt', 
        operands: ['percentchange', params.maxDayChangePct]
      });
    }
    if (params.minVolume != null) {
      body.query.operands.push({
        operator: 'gt',
        operands: ['dayvolume', params.minVolume]
      });
    }
    if (params.minMarketCap != null) {
      body.query.operands.push({
        operator: 'gt',
        operands: ['intradaymarketcap', params.minMarketCap]
      });
    }
    if (params.region) {
      body.query.operands.push({
        operator: 'eq',
        operands: ['region', params.region]
      });
    }
    
    const url = 'https://query2.finance.yahoo.com/v1/finance/screener';
    const r = await pFetch(url + '?formatted=false&lang=en-US&region=US', false);
    // Note: this is a POST request, but since we go through CORS proxy which 
    // typically only supports GET, we may need to fall back to the static pool.
    // Try it first; if it fails, the fallback kicks in automatically.
    const j = await r.json();
    return j.finance?.result?.[0]?.quotes?.map(q => q.symbol) || [];
  } catch (e) {
    console.warn('Yahoo Screener failed, using static pool fallback:', e);
    return null; // null = use fallback
  }
}
```

**重要**：Yahoo Screener API 是 POST 端點，CORS proxy 通常只支援 GET。所以**優先設計為 fallback 會失敗的情況**。如果 screener 失敗，則使用靜態池（SP500_TICKERS 或 TW_SCAN_POOL）。

**替代方案**（如果 Screener API 不通）：使用 `v7/finance/quote` 的批量查詢：

```js
async function batchQuote(tickers) {
  // v7/finance/quote 支持逗號分隔的多檔查詢
  // 每批最多 50 檔
  const results = [];
  for (let i = 0; i < tickers.length; i += 50) {
    const batch = tickers.slice(i, i + 50).join(',');
    try {
      const url = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + encodeURIComponent(batch) + '&fields=symbol,regularMarketPrice,regularMarketChangePercent,regularMarketVolume,averageDailyVolume3Month,regularMarketChange&_t=' + Date.now();
      const r = await pFetch(url, false);
      const j = await r.json();
      if (j.quoteResponse?.result) {
        results.push(...j.quoteResponse.result);
      }
    } catch (e) { console.warn('Batch quote failed for batch', i, e); }
    if (i + 50 < tickers.length) await delay(200);
  }
  return results;
}
```

### 掃描邏輯

#### 掃描流程總管

```js
let _scannerMarket = 'us';
let _scannerStrategy = 'momentum';
let _scannerResults = [];
let _scannerTimer = null;
let _todayWatchlist = JSON.parse(localStorage.getItem('scanner-watchlist') || '[]');
let _watchlistTimer = null;

function switchScannerMarket(market) {
  _scannerMarket = market;
  document.querySelectorAll('#scanner-market-tabs button').forEach((b, i) =>
    b.classList.toggle('active', (market === 'us' ? 0 : 1) === i)
  );
  runScan(_scannerStrategy);
}

async function runScan(strategy) {
  _scannerStrategy = strategy;
  document.querySelectorAll('#scanner-tabs button').forEach((b, i) =>
    b.classList.toggle('active', i === ['momentum','oversold','macd','volume','trend','dip'].indexOf(strategy))
  );
  
  const tableDiv = document.getElementById('scanner-table');
  tableDiv.innerHTML = '<div class="loading"><div class="spinner"></div><p style="margin-top:8px">掃描中（' + (_scannerMarket === 'us' ? '美股' : '台股') + '）...</p></div>';
  
  try {
    // Step 1: Get candidate pool
    let candidates;
    if (_scannerMarket === 'us') {
      // Try Yahoo Screener first for pre-filtering
      const screenerParams = getScreenerParams(strategy);
      const screened = await yahooScreener(screenerParams);
      if (screened && screened.length > 0) {
        candidates = screened;
      } else {
        // Fallback to static pool
        candidates = SP500_TICKERS;
      }
    } else {
      candidates = TW_SCAN_POOL;
    }
    
    // Step 2: Batch quote to get current prices + volume
    const quotes = await batchQuote(candidates);
    
    // Step 3: Pre-filter by strategy-specific criteria (quick filter on quote data)
    const preFiltered = preFilterByStrategy(quotes, strategy);
    
    // Step 4: For stocks passing pre-filter, fetch K-line for detailed analysis
    // Limit to top 30 candidates to keep API calls reasonable
    const top30 = preFiltered.slice(0, 30);
    const results = [];
    
    for (let i = 0; i < top30.length; i += 8) {
      const batch = top30.slice(i, i + 8);
      const batchResults = await Promise.allSettled(
        batch.map(async q => {
          try {
            const chart = await yfChart(q.symbol, '1mo', '1d');
            const oq = chart.indicators.quote[0];
            const c = oq.close.filter(v => v != null);
            const h = oq.high.filter(v => v != null);
            const l = oq.low.filter(v => v != null);
            const v = oq.volume.filter(v => v != null);
            if (c.length < 20) return null;
            
            const price = chart.meta.regularMarketPrice;
            const ta = technicalAnalysis(c, h, l, v, price);
            const signal = classifySignal(ta, q, strategy);
            if (!signal) return null;
            
            return {
              symbol: q.symbol,
              name: q.shortName || q.longName || q.symbol,
              price: price,
              changePct: q.regularMarketChangePercent || 0,
              volume: q.regularMarketVolume || 0,
              avgVolume: q.averageDailyVolume3Month || 0,
              volRatio: q.averageDailyVolume3Month > 0 
                ? (q.regularMarketVolume / q.averageDailyVolume3Month) : 1,
              signal: signal.name,
              signalStrength: signal.strength, // 1-5
              ta: ta,
              closes: c,
              highs: h,
              lows: l
            };
          } catch (e) { return null; }
        })
      );
      results.push(...batchResults
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value));
      if (i + 8 < top30.length) await delay(150);
    }
    
    // Step 5: Sort by signal strength desc
    results.sort((a, b) => b.signalStrength - a.signalStrength);
    _scannerResults = results;
    
    renderScannerResults(results, strategy);
    
  } catch (e) {
    tableDiv.innerHTML = '<div style="text-align:center;color:var(--red);padding:20px">掃描失敗：' + e.message + '<br><button class="btn btn-primary" style="margin-top:12px" onclick="runScan(\'' + strategy + '\')">重試</button></div>';
  }
}
```

#### Pre-Filter 函式（快速篩選，只用 quote 數據）

```js
function preFilterByStrategy(quotes, strategy) {
  return quotes.filter(q => {
    if (!q || !q.regularMarketPrice) return false;
    const pct = q.regularMarketChangePercent || 0;
    const vol = q.regularMarketVolume || 0;
    const avgVol = q.averageDailyVolume3Month || 1;
    const volRatio = vol / avgVol;
    
    switch (strategy) {
      case 'momentum':
        // 漲幅 > 2% 且量比 > 1.3
        return pct > 2 && volRatio > 1.3;
      case 'oversold':
        // 跌幅 > 2%（超賣候選）或近期跌深
        return pct < -2;
      case 'macd':
        // 漲幅在 0-5% 之間（MACD 翻多通常不會是暴漲股）
        return pct > 0 && pct < 5 && vol > avgVol * 0.8;
      case 'volume':
        // 量比 > 2.5（異常放量）
        return volRatio > 2.5;
      case 'trend':
        // 漲幅 > 0（上漲中的才可能均線多排）
        return pct > 0;
      case 'dip':
        // 跌幅 > 5%
        return pct < -5;
      default:
        return true;
    }
  }).sort((a, b) => {
    // 按策略相關性排序
    if (strategy === 'volume') {
      return (b.regularMarketVolume / (b.averageDailyVolume3Month || 1)) 
           - (a.regularMarketVolume / (a.averageDailyVolume3Month || 1));
    }
    if (strategy === 'momentum') return (b.regularMarketChangePercent || 0) - (a.regularMarketChangePercent || 0);
    if (strategy === 'oversold' || strategy === 'dip') return (a.regularMarketChangePercent || 0) - (b.regularMarketChangePercent || 0);
    return 0;
  });
}
```

#### Signal 分類函式（用完整 K 線數據精篩）

```js
function classifySignal(ta, quote, strategy) {
  const pct = quote.regularMarketChangePercent || 0;
  const volRatio = (quote.regularMarketVolume || 0) / (quote.averageDailyVolume3Month || 1);
  
  switch (strategy) {
    case 'momentum': {
      // 動量突破：股價站上 MA20 + 量比 > 1.5 + RSI 50-75
      const aboveMa20 = ta.ma20 && quote.regularMarketPrice > ta.ma20;
      const goodRsi = ta.rsi > 45 && ta.rsi < 80;
      const goodVol = volRatio > 1.3;
      if (!aboveMa20) return null;
      let strength = 1;
      if (goodVol) strength++;
      if (goodRsi) strength++;
      if (ta.macd > ta.signal) strength++;
      if (ta.kd.k > ta.kd.d) strength++;
      return { name: '動量突破', strength };
    }
    case 'oversold': {
      // 超賣反彈：RSI < 35 或 KD < 25 或觸及布林下軌
      const rsiOversold = ta.rsi < 35;
      const kdOversold = ta.kd.k < 25;
      const bbLow = ta.bb.lo != null && quote.regularMarketPrice <= ta.bb.lo * 1.02;
      if (!rsiOversold && !kdOversold && !bbLow) return null;
      let strength = 1;
      if (rsiOversold) strength++;
      if (kdOversold) strength++;
      if (bbLow) strength++;
      if (ta.kd.k > ta.kd.d && ta.kd.k < 30) strength++; // KD 低檔黃金交叉
      return { name: '超賣反彈', strength };
    }
    case 'macd': {
      // MACD 翻多：柱狀從負轉正
      const histNow = ta.hist;
      if (histNow <= 0) return null;
      let strength = 2;
      if (ta.macd > ta.signal) strength++;
      if (quote.regularMarketPrice > ta.ma20) strength++;
      if (ta.rsi > 45 && ta.rsi < 65) strength++;
      return { name: 'MACD翻多', strength };
    }
    case 'volume': {
      // 放量異動：量比 > 2.5
      if (volRatio < 2.5) return null;
      let strength = Math.min(5, Math.floor(volRatio));
      return { name: '放量異動 (' + volRatio.toFixed(1) + 'x)', strength };
    }
    case 'trend': {
      // 均線多頭排列：MA5 > MA20 > MA60
      if (!ta.ma5 || !ta.ma20 || !ta.ma60) return null;
      if (!(ta.ma5 > ta.ma20 && ta.ma20 > ta.ma60)) return null;
      let strength = 3;
      if (ta.rsi > 50 && ta.rsi < 70) strength++;
      if (ta.macd > 0) strength++;
      return { name: '均線多頭排列', strength };
    }
    case 'dip': {
      // 跌深股：RSI < 30 + 大跌
      if (ta.rsi > 35) return null;
      let strength = 1;
      if (ta.rsi < 25) strength++;
      if (ta.kd.k < 20) strength++;
      if (ta.bb.lo != null && quote.regularMarketPrice < ta.bb.lo) strength++;
      if (pct < -8) strength++;
      return { name: '跌深 (RSI:' + ta.rsi.toFixed(0) + ')', strength };
    }
  }
  return null;
}
```

#### 掃描結果渲染

```js
function renderScannerResults(results, strategy) {
  const tableDiv = document.getElementById('scanner-table');
  const strategyNames = {
    momentum: '🚀 動量突破', oversold: '📉 超賣反彈', macd: '📊 MACD翻多',
    volume: '📢 放量異動', trend: '📈 均線多排', dip: '💎 跌深股'
  };
  
  if (!results.length) {
    tableDiv.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)">目前無符合「' + strategyNames[strategy] + '」條件的股票</div>';
    return;
  }
  
  let html = '<div style="font-size:13px;color:var(--muted);margin-bottom:12px">找到 ' + results.length + ' 檔符合「' + strategyNames[strategy] + '」的股票</div>';
  html += '<div class="table-wrap"><table><thead><tr><th>代號</th><th>名稱</th><th>現價</th><th>漲跌%</th><th>量比</th><th>信號</th><th>強度</th><th>RSI</th><th>操作</th></tr></thead><tbody>';
  
  results.forEach(r => {
    const up = r.changePct >= 0;
    const stars = '★'.repeat(r.signalStrength) + '☆'.repeat(5 - r.signalStrength);
    const inWatchlist = _todayWatchlist.some(w => w.symbol === r.symbol);
    
    html += '<tr>' +
      '<td><b style="cursor:pointer;color:var(--accent)" onclick="document.getElementById(\'ticker-input\').value=\'' + r.symbol + '\';showPage(\'stock\');analyzeStock()">' + r.symbol + '</b></td>' +
      '<td>' + r.name + '</td>' +
      '<td>' + r.price.toFixed(2) + '</td>' +
      '<td style="color:' + (up ? 'var(--green)' : 'var(--red)') + '">' + (up ? '+' : '') + r.changePct.toFixed(2) + '%</td>' +
      '<td>' + r.volRatio.toFixed(1) + 'x</td>' +
      '<td><span class="tag" style="background:rgba(59,130,246,.15);color:var(--accent)">' + r.signal + '</span></td>' +
      '<td style="color:var(--yellow)">' + stars + '</td>' +
      '<td>' + r.ta.rsi.toFixed(0) + '</td>' +
      '<td>' + (inWatchlist
        ? '<span style="color:var(--green)">✓ 已加入</span>'
        : '<button class="btn btn-primary btn-sm" onclick="addToWatchlist(\'' + r.symbol + '\')">+ 加入</button>')
      + '</td></tr>';
  });
  
  html += '</tbody></table></div>';
  tableDiv.innerHTML = html;
}
```

### 今日標的（即時監控區域）

#### 加入/移除

```js
function addToWatchlist(symbol) {
  // 最多 15 檔
  if (_todayWatchlist.length >= 15) {
    alert('今日標的最多 15 檔，請先移除不需要的');
    return;
  }
  if (_todayWatchlist.some(w => w.symbol === symbol)) return;
  
  const result = _scannerResults.find(r => r.symbol === symbol);
  _todayWatchlist.push({
    symbol: symbol,
    name: result ? result.name : symbol,
    addedPrice: result ? result.price : 0,
    entryPrice: null, // 用戶自設
    stopPrice: null,  // 用戶自設
    strategy: _scannerStrategy,
    signal: result ? result.signal : '',
    alerts: []
  });
  
  saveTodayWatchlist();
  renderWatchlist();
  renderScannerResults(_scannerResults, _scannerStrategy); // 更新按鈕狀態
  startWatchlistRefresh(); // 開始高頻刷新
}

function removeFromWatchlist(symbol) {
  _todayWatchlist = _todayWatchlist.filter(w => w.symbol !== symbol);
  saveTodayWatchlist();
  renderWatchlist();
  if (_todayWatchlist.length === 0) stopWatchlistRefresh();
}

function saveTodayWatchlist() {
  localStorage.setItem('scanner-watchlist', JSON.stringify(_todayWatchlist));
}
```

#### 即時監控刷新

```js
function startWatchlistRefresh() {
  if (_watchlistTimer) return; // 已在運行
  if (_todayWatchlist.length === 0) return;
  
  _watchlistTimer = setInterval(async () => {
    if (_currentPage !== 'scanner') return;
    await refreshWatchlist();
  }, 10000); // 每 10 秒
  
  // 立即執行一次
  refreshWatchlist();
}

function stopWatchlistRefresh() {
  if (_watchlistTimer) {
    clearInterval(_watchlistTimer);
    _watchlistTimer = null;
  }
}

async function refreshWatchlist() {
  if (_todayWatchlist.length === 0) return;
  
  const symbols = _todayWatchlist.map(w => w.symbol);
  const quotes = await batchQuote(symbols);
  
  _todayWatchlist.forEach(w => {
    const q = quotes.find(qq => qq.symbol === w.symbol);
    if (q) {
      w.currentPrice = q.regularMarketPrice;
      w.changePct = q.regularMarketChangePercent;
      w.volume = q.regularMarketVolume;
      w.avgVolume = q.averageDailyVolume3Month;
      w.dayHigh = q.regularMarketDayHigh;
      w.dayLow = q.regularMarketDayLow;
      
      // 檢查警報
      if (w.entryPrice && w.currentPrice <= w.entryPrice && !w.alerts.includes('entry')) {
        w.alerts.push('entry');
        triggerAlert(w.symbol, '已觸及進場價 ' + w.entryPrice);
      }
      if (w.stopPrice && w.currentPrice <= w.stopPrice && !w.alerts.includes('stop')) {
        w.alerts.push('stop');
        triggerAlert(w.symbol, '⚠️ 已觸及停損價 ' + w.stopPrice);
      }
    }
  });
  
  renderWatchlist();
}

function triggerAlert(symbol, message) {
  // 螢幕頂部通知條
  const notification = document.createElement('div');
  notification.style.cssText = 'position:fixed;top:0;left:0;right:0;padding:12px 20px;background:var(--accent);color:#fff;font-weight:600;text-align:center;z-index:9999;animation:flashGreen 2s ease-out';
  notification.textContent = '🔔 ' + symbol + ': ' + message;
  document.body.appendChild(notification);
  setTimeout(() => notification.remove(), 5000);
  
  // 嘗試播放音效（瀏覽器允許的話）
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.value = 0.1;
    osc.start();
    setTimeout(() => { osc.stop(); ctx.close(); }, 200);
  } catch (e) {}
}
```

#### 監控卡片渲染

```js
function renderWatchlist() {
  const cardsDiv = document.getElementById('watchlist-cards');
  const emptyDiv = document.getElementById('watchlist-empty');
  const statusEl = document.getElementById('scanner-market-status');
  
  // 市場狀態
  const now = new Date();
  const utcH = now.getUTCHours(), utcM = now.getUTCMinutes();
  const utcMin = utcH * 60 + utcM;
  const usOpen = utcMin >= 810 && utcMin < 1200; // 13:30-20:00 UTC
  const twOpen = utcMin >= 60 && utcMin < 330;    // 01:00-05:30 UTC
  const day = now.getDay();
  const weekday = day >= 1 && day <= 5;
  
  let marketStatus = '';
  if (_scannerMarket === 'us') {
    marketStatus = usOpen && weekday ? '<span style="color:var(--green)">🟢 美股開盤中</span>' : '<span style="color:var(--muted)">⚪ 美股休市</span>';
  } else {
    marketStatus = twOpen && weekday ? '<span style="color:var(--green)">🟢 台股開盤中</span>' : '<span style="color:var(--muted)">⚪ 台股休市</span>';
  }
  if (_todayWatchlist.length > 0) {
    marketStatus += ' · <span style="color:var(--accent)">每 10 秒刷新</span>';
  }
  statusEl.innerHTML = marketStatus;
  
  if (_todayWatchlist.length === 0) {
    cardsDiv.innerHTML = '';
    emptyDiv.style.display = 'block';
    return;
  }
  emptyDiv.style.display = 'none';
  
  let html = '';
  _todayWatchlist.forEach(w => {
    const up = (w.changePct || 0) >= 0;
    const hasAlert = w.alerts && w.alerts.length > 0;
    const borderColor = hasAlert ? 'var(--yellow)' : 'var(--border)';
    const flashClass = w.alerts?.includes('entry') ? 'style="animation:flashGreen 1s infinite"' : '';
    
    html += '<div class="card" style="border-color:' + borderColor + ';margin-bottom:12px" ' + flashClass + '>';
    
    // Header row
    html += '<div style="display:flex;justify-content:space-between;align-items:center">';
    html += '<div><b style="font-size:18px;cursor:pointer;color:var(--accent)" onclick="document.getElementById(\'ticker-input\').value=\'' + w.symbol + '\';showPage(\'stock\');analyzeStock()">' + w.symbol + '</b> <span style="color:var(--muted);font-size:13px">' + (w.name || '') + '</span></div>';
    html += '<div style="text-align:right"><div style="font-size:22px;font-weight:700">' + (w.currentPrice ? w.currentPrice.toFixed(2) : '-') + '</div>';
    html += '<span style="color:' + (up ? 'var(--green)' : 'var(--red)') + ';font-weight:600">' + (up ? '+' : '') + (w.changePct ? w.changePct.toFixed(2) : '0') + '%</span></div>';
    html += '</div>';
    
    // Info row
    html += '<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin:8px 0">';
    html += '<span>信號: <span class="tag" style="background:rgba(59,130,246,.15);color:var(--accent)">' + (w.signal || '-') + '</span></span>';
    html += '<span>量: ' + (w.volume ? (w.volume / 1e6).toFixed(1) + 'M' : '-') + '</span>';
    html += '<span>今高: ' + (w.dayHigh ? w.dayHigh.toFixed(2) : '-') + '</span>';
    html += '<span>今低: ' + (w.dayLow ? w.dayLow.toFixed(2) : '-') + '</span>';
    html += '</div>';
    
    // Entry/Stop settings
    html += '<div style="display:flex;gap:12px;margin:8px 0;align-items:center;flex-wrap:wrap">';
    html += '<div class="form-group" style="flex:1;min-width:120px"><label>進場價</label><input type="number" step="0.01" value="' + (w.entryPrice || '') + '" onchange="updateWatchlistField(\'' + w.symbol + '\',\'entryPrice\',this.value)" placeholder="設定進場觸發價" style="padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;width:100%"></div>';
    html += '<div class="form-group" style="flex:1;min-width:120px"><label>停損價</label><input type="number" step="0.01" value="' + (w.stopPrice || '') + '" onchange="updateWatchlistField(\'' + w.symbol + '\',\'stopPrice\',this.value)" placeholder="設定停損觸發價" style="padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;width:100%"></div>';
    
    // 自動計算 R 倍數
    if (w.entryPrice && w.stopPrice && w.entryPrice > w.stopPrice) {
      const risk = w.entryPrice - w.stopPrice;
      const atr = risk; // approximation
      const target = w.entryPrice + risk * 2.5;
      const rr = ((target - w.entryPrice) / risk).toFixed(1);
      html += '<div style="text-align:center;min-width:80px"><div style="font-size:11px;color:var(--muted)">停利目標</div><div style="font-size:16px;font-weight:700;color:var(--accent)">' + target.toFixed(2) + '</div><div style="font-size:11px;color:var(--yellow)">R倍數 1:' + rr + '</div></div>';
    }
    html += '</div>';
    
    // 警報狀態
    if (w.alerts?.includes('entry')) {
      html += '<div style="padding:8px 12px;background:rgba(16,185,129,.15);border-radius:8px;color:var(--green);font-weight:600;margin:8px 0">🔔 已觸及進場價！請確認是否符合交易計畫後決策</div>';
    }
    if (w.alerts?.includes('stop')) {
      html += '<div style="padding:8px 12px;background:rgba(239,68,68,.15);border-radius:8px;color:var(--red);font-weight:600;margin:8px 0">⚠️ 已觸及停損價！建議立即評估是否出場</div>';
    }
    
    // Action buttons
    html += '<div style="display:flex;gap:8px;margin-top:8px">';
    html += '<button class="btn btn-sm" style="background:var(--bg);border:1px solid var(--border);color:var(--text)" onclick="showWatchlistChart(\'' + w.symbol + '\')">展開K線</button>';
    html += '<button class="btn btn-danger btn-sm" onclick="removeFromWatchlist(\'' + w.symbol + '\')">移除</button>';
    html += '</div>';
    
    // Expandable K-line area
    html += '<div id="watchlist-chart-' + w.symbol.replace('.', '_') + '" style="display:none;margin-top:12px"></div>';
    
    html += '</div>';
  });
  
  cardsDiv.innerHTML = html;
}

function updateWatchlistField(symbol, field, value) {
  const w = _todayWatchlist.find(w => w.symbol === symbol);
  if (w) {
    w[field] = parseFloat(value) || null;
    saveTodayWatchlist();
    renderWatchlist();
  }
}

async function showWatchlistChart(symbol) {
  const chartId = 'watchlist-chart-' + symbol.replace('.', '_');
  const el = document.getElementById(chartId);
  if (!el) return;
  
  if (el.style.display !== 'none') {
    el.style.display = 'none';
    return;
  }
  
  el.style.display = 'block';
  el.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  el.style.height = '300px';
  
  try {
    const chart = await yfChart(symbol, '1mo', '1d');
    const q = chart.indicators.quote[0];
    const ohlcv = [];
    for (let i = 0; i < chart.timestamp.length; i++) {
      if (q.close[i] != null) ohlcv.push({
        t: chart.timestamp[i], o: q.open[i], h: q.high[i],
        l: q.low[i], c: q.close[i], v: q.volume[i] || 0
      });
    }
    el.innerHTML = '';
    renderKline(chartId, ohlcv);
  } catch (e) {
    el.innerHTML = '<div style="color:var(--red);padding:12px">圖表載入失敗</div>';
  }
}
```

### 掃描器初始化（盤前/盤中/盤後模式）

```js
function loadScanner() {
  updateScannerMarketStatus();
  renderWatchlist();
  
  if (_todayWatchlist.length > 0) {
    startWatchlistRefresh();
  }
  
  // 自動掃描定時器（每 3 分鐘背景掃描）
  if (_scannerTimer) clearInterval(_scannerTimer);
  _scannerTimer = setInterval(() => {
    if (_currentPage === 'scanner') {
      runScan(_scannerStrategy);
    }
  }, 180000);
}

function updateScannerMarketStatus() {
  // 此函式在 renderWatchlist 中已處理
}
```

---

## 模組 B：風控中心

### 頁面結構

```html
<div id="page-risk" class="page">
  <h2 style="margin-bottom:20px">🛡️ 風控中心</h2>
  <div id="risk-content"></div>
</div>
```

### 風控中心邏輯

```js
function renderRisk() {
  const div = document.getElementById('risk-content');
  div.innerHTML = `
  <!-- 倉位計算器 -->
  <div class="card">
    <h3>📐 倉位計算器（Position Sizing）</h3>
    <p style="font-size:13px;color:var(--muted);margin-bottom:16px">
      基於 Marty Schwartz 的 1% 法則：單筆交易最大虧損不超過總資金的 1-2%。
    </p>
    <div class="journal-form" style="grid-template-columns:1fr 1fr">
      <div class="form-group"><label>總資金</label><input type="number" id="risk-capital" placeholder="1000000" step="1000"></div>
      <div class="form-group"><label>風險比例</label><select id="risk-pct">
        <option value="0.5">0.5%（極保守）</option>
        <option value="1" selected>1%（標準）</option>
        <option value="1.5">1.5%（積極）</option>
        <option value="2">2%（激進）</option>
        <option value="3">3%（高風險）</option>
      </select></div>
      <div class="form-group"><label>進場價</label><input type="number" id="risk-entry" step="0.01" placeholder="150.00"></div>
      <div class="form-group"><label>停損價</label><input type="number" id="risk-stop" step="0.01" placeholder="145.00"></div>
      <div class="form-group"><label>市場</label><select id="risk-market" onchange="riskMarketChange()">
        <option value="us">美股</option>
        <option value="tw">台股</option>
      </select></div>
      <div class="form-group"><label>&nbsp;</label><button class="btn btn-primary" onclick="calcPosition()" style="width:100%">計算倉位</button></div>
    </div>
  </div>
  <div id="position-result"></div>
  
  <!-- R 倍數情境模擬 -->
  <div class="card">
    <h3>🎯 R 倍數情境模擬器</h3>
    <p style="font-size:13px;color:var(--muted);margin-bottom:12px">
      1R = 你的停損距離。如果虧損 1R 是虧 $500，那獲利 3R 就是賺 $1500。
    </p>
    <div id="r-multiple-result"></div>
  </div>
  
  <!-- Kelly Criterion -->
  <div class="card">
    <h3>📊 Kelly Criterion 最佳倉位</h3>
    <p style="font-size:13px;color:var(--muted);margin-bottom:16px">
      根據你的歷史勝率和盈虧比，計算數學上最佳的倉位比例。
    </p>
    <div class="journal-form" style="grid-template-columns:1fr 1fr 1fr">
      <div class="form-group"><label>勝率 (%)</label><input type="number" id="kelly-winrate" value="55" min="1" max="99" step="1"></div>
      <div class="form-group"><label>平均獲利 / 平均虧損</label><input type="number" id="kelly-ratio" value="1.5" min="0.1" step="0.1"></div>
      <div class="form-group"><label>&nbsp;</label><button class="btn btn-primary" onclick="calcKelly()">計算 Kelly</button></div>
    </div>
    <div id="kelly-result"></div>
    <div style="margin-top:8px;font-size:12px;color:var(--orange)">
      💡 實務上建議使用 Half Kelly（凱利值的一半），以降低波動。
    </div>
  </div>
  
  <!-- 連續虧損模擬 -->
  <div class="card">
    <h3>💀 最大回撤模擬</h3>
    <p style="font-size:13px;color:var(--muted);margin-bottom:16px">
      模擬連續虧損時你的資金會怎樣。這就是風控存在的意義。
    </p>
    <div class="journal-form" style="grid-template-columns:1fr 1fr 1fr">
      <div class="form-group"><label>起始資金</label><input type="number" id="dd-capital" value="1000000" step="1000"></div>
      <div class="form-group"><label>每次虧損比例 (%)</label><input type="number" id="dd-loss" value="2" min="0.1" max="50" step="0.5"></div>
      <div class="form-group"><label>&nbsp;</label><button class="btn btn-primary" onclick="calcDrawdown()">模擬</button></div>
    </div>
    <div id="dd-result"></div>
  </div>
  
  <!-- 5 種策略模板 -->
  <div class="card">
    <h3>📋 交易策略模板</h3>
    <div class="tab-bar" id="strategy-tabs">
      <button class="active" onclick="showStrategy('breakout')">突破交易</button>
      <button onclick="showStrategy('meanrev')">均值回歸</button>
      <button onclick="showStrategy('momentum')">動量追蹤</button>
      <button onclick="showStrategy('gap')">缺口交易</button>
      <button onclick="showStrategy('orb')">開盤區間突破</button>
    </div>
    <div id="strategy-detail"></div>
  </div>
  `;
  
  showStrategy('breakout');
  // 嘗試從交易日誌自動帶入 Kelly
  autoFillKellyFromJournal();
}
```

### 倉位計算核心

```js
function calcPosition() {
  const capital = parseFloat(document.getElementById('risk-capital').value) || 0;
  const riskPct = parseFloat(document.getElementById('risk-pct').value) / 100;
  const entry = parseFloat(document.getElementById('risk-entry').value) || 0;
  const stop = parseFloat(document.getElementById('risk-stop').value) || 0;
  const market = document.getElementById('risk-market').value;
  
  if (!capital || !entry || !stop || entry <= stop) {
    document.getElementById('position-result').innerHTML = '<div class="card" style="color:var(--red);text-align:center">請填寫完整資料，且進場價必須大於停損價</div>';
    return;
  }
  
  const maxLoss = capital * riskPct;
  const riskPerShare = entry - stop;
  let shares = Math.floor(maxLoss / riskPerShare);
  
  // 台股以張為單位（1張=1000股）
  if (market === 'tw') {
    shares = Math.floor(shares / 1000) * 1000;
  }
  
  const totalCost = shares * entry;
  const actualLoss = shares * riskPerShare;
  const capitalPct = (totalCost / capital * 100);
  
  // R 倍數模擬
  const rMultiples = [1, 1.5, 2, 2.5, 3, 5];
  
  let html = '<div class="card">';
  html += '<h3>📐 計算結果</h3>';
  html += '<div style="text-align:center;padding:20px 0">';
  html += '<div style="font-size:14px;color:var(--muted)">建議買入數量</div>';
  html += '<div style="font-size:48px;font-weight:700;color:var(--accent)">' + shares.toLocaleString() + ' 股</div>';
  if (market === 'tw') html += '<div style="font-size:16px;color:var(--muted)">(' + (shares / 1000) + ' 張)</div>';
  html += '</div>';
  
  html += '<div class="table-wrap"><table>';
  html += '<tr><td style="color:var(--muted)">總投入金額</td><td style="text-align:right"><b>' + (market === 'tw' ? 'NT$' : '$') + totalCost.toLocaleString() + '</b></td></tr>';
  html += '<tr><td style="color:var(--muted)">佔總資金比例</td><td style="text-align:right"><b>' + capitalPct.toFixed(1) + '%</b></td></tr>';
  html += '<tr><td style="color:var(--muted)">單股風險</td><td style="text-align:right"><b>' + riskPerShare.toFixed(2) + '</b> (進場到停損距離)</td></tr>';
  html += '<tr><td style="color:var(--muted)">最大虧損 (1R)</td><td style="text-align:right;color:var(--red)"><b>' + (market === 'tw' ? 'NT$' : '$') + actualLoss.toLocaleString() + '</b></td></tr>';
  html += '<tr><td style="color:var(--muted)">佔總資金</td><td style="text-align:right;color:var(--red)"><b>' + (actualLoss / capital * 100).toFixed(2) + '%</b></td></tr>';
  html += '</table></div>';
  
  // R 倍數模擬
  html += '<h3 style="margin-top:20px">🎯 R 倍數情境</h3>';
  html += '<div class="table-wrap"><table><thead><tr><th>情境</th><th>出場價</th><th>損益</th><th>報酬率</th></tr></thead><tbody>';
  
  // 虧損情境
  html += '<tr style="background:rgba(239,68,68,.05)"><td>停損 (-1R)</td><td>' + stop.toFixed(2) + '</td><td style="color:var(--red)">-' + (market === 'tw' ? 'NT$' : '$') + actualLoss.toLocaleString() + '</td><td style="color:var(--red)">-' + riskPct * 100 + '%</td></tr>';
  
  rMultiples.forEach(r => {
    const exitPrice = entry + riskPerShare * r;
    const profit = shares * riskPerShare * r;
    const pctReturn = (profit / capital * 100);
    html += '<tr style="background:rgba(16,185,129,.05)"><td>+' + r + 'R</td><td>' + exitPrice.toFixed(2) + '</td><td style="color:var(--green)">+' + (market === 'tw' ? 'NT$' : '$') + profit.toLocaleString() + '</td><td style="color:var(--green)">+' + pctReturn.toFixed(2) + '%</td></tr>';
  });
  
  html += '</tbody></table></div></div>';
  
  document.getElementById('position-result').innerHTML = html;
}
```

### Kelly Criterion

```js
function calcKelly() {
  const winRate = parseFloat(document.getElementById('kelly-winrate').value) / 100;
  const ratio = parseFloat(document.getElementById('kelly-ratio').value);
  
  if (!winRate || !ratio || winRate <= 0 || winRate >= 1) {
    document.getElementById('kelly-result').innerHTML = '<div style="color:var(--red)">請輸入有效數值</div>';
    return;
  }
  
  const kelly = winRate - (1 - winRate) / ratio;
  const halfKelly = kelly / 2;
  const expectancy = winRate * ratio - (1 - winRate);
  
  let html = '<div style="display:flex;gap:20px;flex-wrap:wrap;margin-top:12px">';
  html += '<div style="text-align:center;padding:16px;background:var(--bg);border-radius:8px;flex:1;min-width:120px"><div style="font-size:12px;color:var(--muted)">Full Kelly</div><div style="font-size:28px;font-weight:700;color:' + (kelly > 0 ? 'var(--accent)' : 'var(--red)') + '">' + (kelly * 100).toFixed(1) + '%</div></div>';
  html += '<div style="text-align:center;padding:16px;background:var(--bg);border-radius:8px;flex:1;min-width:120px;border:2px solid var(--accent)"><div style="font-size:12px;color:var(--muted)">Half Kelly (建議)</div><div style="font-size:28px;font-weight:700;color:var(--green)">' + (halfKelly * 100).toFixed(1) + '%</div></div>';
  html += '<div style="text-align:center;padding:16px;background:var(--bg);border-radius:8px;flex:1;min-width:120px"><div style="font-size:12px;color:var(--muted)">期望值</div><div style="font-size:28px;font-weight:700;color:' + (expectancy > 0 ? 'var(--green)' : 'var(--red)') + '">' + (expectancy > 0 ? '+' : '') + expectancy.toFixed(3) + '</div></div>';
  html += '</div>';
  
  if (kelly <= 0) {
    html += '<div style="margin-top:12px;padding:12px;background:rgba(239,68,68,.1);border-radius:8px;color:var(--red)">⚠️ Kelly 值為負，表示這個策略的勝率和盈虧比組合沒有正期望值，<b>不應該交易</b>。</div>';
  }
  
  document.getElementById('kelly-result').innerHTML = html;
}

function autoFillKellyFromJournal() {
  const j = getJ();
  if (j.length < 10) return; // 需要至少 10 筆紀錄
  
  // 計算配對交易的勝率和盈虧比
  // 簡化：只看有 buy+sell 配對的
  const buys = {}, wins = 0, losses = 0, totalWin = 0, totalLoss = 0;
  j.forEach(e => {
    if (e.action === 'buy') buys[e.ticker] = e.price;
    if (e.action === 'sell' && buys[e.ticker]) {
      const pnl = e.price - buys[e.ticker];
      if (pnl > 0) { wins++; totalWin += pnl; }
      else { losses++; totalLoss += Math.abs(pnl); }
      delete buys[e.ticker];
    }
  });
  
  const total = wins + losses;
  if (total < 5) return;
  
  const winRate = (wins / total * 100).toFixed(0);
  const avgWin = wins > 0 ? totalWin / wins : 0;
  const avgLoss = losses > 0 ? totalLoss / losses : 1;
  const ratio = (avgWin / avgLoss).toFixed(2);
  
  document.getElementById('kelly-winrate').value = winRate;
  document.getElementById('kelly-ratio').value = ratio;
}
```

### 最大回撤模擬

```js
function calcDrawdown() {
  const capital = parseFloat(document.getElementById('dd-capital').value) || 1000000;
  const lossPct = parseFloat(document.getElementById('dd-loss').value) / 100 || 0.02;
  
  let remaining = capital;
  let html = '<div class="table-wrap"><table><thead><tr><th>連虧次數</th><th>剩餘資金</th><th>累計回撤</th><th>需回彈 %</th></tr></thead><tbody>';
  
  for (let i = 1; i <= 20; i++) {
    remaining *= (1 - lossPct);
    const drawdown = ((capital - remaining) / capital * 100);
    const recoverPct = ((capital / remaining - 1) * 100);
    const color = drawdown > 30 ? 'var(--red)' : drawdown > 15 ? 'var(--orange)' : 'var(--yellow)';
    
    html += '<tr><td>' + i + '</td>';
    html += '<td><b>' + Math.round(remaining).toLocaleString() + '</b></td>';
    html += '<td style="color:' + color + '">-' + drawdown.toFixed(1) + '%</td>';
    html += '<td style="color:' + color + '">+' + recoverPct.toFixed(1) + '%</td></tr>';
  }
  
  html += '</tbody></table></div>';
  html += '<div style="margin-top:12px;padding:12px;background:rgba(239,68,68,.1);border-radius:8px;font-size:13px;color:var(--muted)">💡 虧損 50% 需要上漲 100% 才能回本。這就是為什麼 <b style="color:var(--text)">控制每次虧損在 1-2% 極為重要</b> — 即使連虧 10 次也只虧約 10-18%，仍可恢復。</div>';
  
  document.getElementById('dd-result').innerHTML = html;
}
```

### 策略模板

```js
function showStrategy(type) {
  document.querySelectorAll('#strategy-tabs button').forEach((b, i) =>
    b.classList.toggle('active', i === ['breakout','meanrev','momentum','gap','orb'].indexOf(type))
  );
  
  const strategies = {
    breakout: {
      name: '突破交易（Breakout）',
      desc: '當股價突破盤整區間或 N 日高點，順勢進場。Marty Schwartz 最擅長的策略。',
      timeframe: '日線 / 4 小時線',
      entry: ['價格突破 20 日高點', '成交量 > 1.5 倍 20 日均量', 'RSI 在 50-75 之間（有動能但不超買）', 'MACD 柱狀為正'],
      stop: '突破線下方 1 ATR',
      target: '2-3 ATR，或前次歷史高點',
      rr: '1:2 至 1:3',
      notes: '假突破是最大敵人。量能確認是關鍵——沒有量的突破很可能是假的。開盤第一小時的突破成功率最高。'
    },
    meanrev: {
      name: '均值回歸（Mean Reversion）',
      desc: '當股價偏離均值過多時，逆勢進場等待回歸。適合盤整市場。',
      timeframe: '日線 / 1 小時線',
      entry: ['RSI < 30（超賣）', '股價觸及布林通道下軌', 'KD 在超賣區出現黃金交叉', '非系統性風險造成的下跌（非財報暴雷/行業利空）'],
      stop: '進場價下方 1.5 ATR',
      target: '回到 MA20 或布林中軌',
      rr: '1:1.5 至 1:2',
      notes: '「接飛刀」風險高。務必確認不是基本面惡化造成的下跌。適合在大盤上漲趨勢中逢低買入。'
    },
    momentum: {
      name: '動量追蹤（Momentum / Trend Following）',
      desc: '順著趨勢方向交易，讓利潤奔跑。Steinhardt 的核心策略之一。',
      timeframe: '4 小時線 / 日線',
      entry: ['EMA8 > EMA21 > EMA60（均線多頭排列）', 'MACD > 0 且柱狀擴大', 'RSI 在 50-70（有動能但不過熱）', '股價在上升趨勢線之上'],
      stop: 'EMA21 下方（移動停損，隨 EMA21 上移）',
      target: '不設固定目標，用 Trailing Stop（移動停損 = 2 ATR）',
      rr: '1:3 以上（讓利潤奔跑）',
      notes: '動量策略的關鍵是「截斷虧損，讓利潤奔跑」。不要因為賺了一點就急著出場。移動停損是你最好的朋友。'
    },
    gap: {
      name: '缺口交易（Gap Trading）',
      desc: '利用開盤跳空缺口進行交易。需要快速反應。',
      timeframe: '5 分鐘 / 15 分鐘（盤中操作）',
      entry: ['跳空開高或開低 > 2%', '成交量在開盤 5 分鐘內爆量', '缺口方向與大盤趨勢一致', '非除權息或重大事件造成的缺口'],
      stop: '缺口回補價位（缺口被完全填補時出場）',
      target: '缺口方向 1.5-2 ATR',
      rr: '1:1.5 至 1:2',
      notes: '統計上，約 70% 的缺口會在當天或隔天回補。所以「順缺口方向」交易的勝率不高，但「等缺口回補」策略較穩定。需要配合量能判斷。⚠️ 本工具數據延遲約 15-20 秒，此策略建議搭配券商即時軟體使用。'
    },
    orb: {
      name: '開盤區間突破（Opening Range Breakout, ORB）',
      desc: '等待開盤前 15-30 分鐘形成的高低範圍，突破後順勢交易。經典日內策略。',
      timeframe: '5 分鐘',
      entry: ['記錄開盤前 30 分鐘的最高價和最低價', '股價突破這個範圍的高點 → 做多', '股價跌破這個範圍的低點 → 觀望（除非做空）', '成交量確認（突破時量 > 均量）'],
      stop: '區間中點（(高+低)/2）',
      target: '區間寬度的 1.5-2 倍',
      rr: '1:1.5 至 1:2',
      notes: '這是最適合新手的日內策略，規則明確。但在窄幅盤整日效果差。建議在 VIX > 15 的日子使用（有波動才有機會）。⚠️ 本工具數據延遲約 15-20 秒，此策略建議搭配券商即時軟體使用。'
    }
  };
  
  const s = strategies[type];
  let html = '<div style="margin-top:16px">';
  html += '<div style="font-size:18px;font-weight:700;margin-bottom:8px">' + s.name + '</div>';
  html += '<p style="color:var(--muted);line-height:1.8;margin-bottom:16px">' + s.desc + '</p>';
  html += '<div style="display:flex;gap:8px;margin-bottom:16px"><span class="tag" style="background:rgba(59,130,246,.15);color:var(--accent)">⏱ ' + s.timeframe + '</span><span class="tag" style="background:rgba(245,158,11,.15);color:var(--yellow)">R:R ' + s.rr + '</span></div>';
  
  html += '<div class="edu-card" style="margin-bottom:12px"><p><span class="edu-term">✅ 進場條件 Checklist</span></p>';
  s.entry.forEach(e => { html += '<p>☐ ' + e + '</p>'; });
  html += '</div>';
  
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">';
  html += '<div class="edu-card"><p><span class="edu-term">🛑 停損</span></p><p>' + s.stop + '</p></div>';
  html += '<div class="edu-card"><p><span class="edu-term">🎯 停利</span></p><p>' + s.target + '</p></div>';
  html += '</div>';
  
  html += '<div style="margin-top:12px;padding:12px;background:rgba(59,130,246,.05);border-radius:8px;font-size:13px;line-height:1.8;color:var(--muted)">💡 <b style="color:var(--text)">實戰筆記：</b>' + s.notes + '</div>';
  html += '</div>';
  
  document.getElementById('strategy-detail').innerHTML = html;
}
```

---

## 模組 C：多時間框架分析（強化個股分析頁）

### 修改 `analyzeStock()` 函式

在現有個股分析頁面的 K 線圖上方，新增時間框架選擇器。

在 `renderStock()` 和 `renderBond()` 函式回傳的 HTML 中，找到 K 線圖的部分：
```
📈 K線走勢圖（6個月）
```

替換為：

```js
'<div class="card"><h3>📈 K線走勢圖</h3>' +
'<div class="tab-bar" style="margin-bottom:8px">' +
'<button class="active" onclick="switchStockTF(\'' + ticker + '\',\'6mo\',\'1d\',this)">日線 6M</button>' +
'<button onclick="switchStockTF(\'' + ticker + '\',\'1mo\',\'1h\',this)">1H 月線</button>' +
'<button onclick="switchStockTF(\'' + ticker + '\',\'5d\',\'15m\',this)">15m 週線</button>' +
'<button onclick="switchStockTF(\'' + ticker + '\',\'1d\',\'5m\',this)">5m 日內</button>' +
'<button onclick="switchStockTF(\'' + ticker + '\',\'2y\',\'1wk\',this)">週線 2Y</button>' +
'</div>' +
'<div id="stock-kline" class="chart-container"></div>' +
// ... MA legend
```

新增切換函式：

```js
async function switchStockTF(ticker, range, interval, btn) {
  // Update active button
  if (btn) {
    btn.parentElement.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }
  
  const el = document.getElementById('stock-kline');
  el.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  
  try {
    const chart = await yfChart(ticker, range, interval);
    const q = chart.indicators.quote[0];
    const ohlcv = [];
    for (let i = 0; i < chart.timestamp.length; i++) {
      if (q.close[i] != null && q.open[i] != null) {
        ohlcv.push({ t: chart.timestamp[i], o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 });
      }
    }
    el.innerHTML = '';
    renderKline('stock-kline', ohlcv);
  } catch (e) {
    el.innerHTML = '<div style="color:var(--red);padding:12px">載入失敗: ' + e.message + '</div>';
  }
}
```

---

## 模組 D：進階技術指標

### 新增指標函式

在現有的 `// ============ MATH ============` 區塊（L1232-1239）後面新增：

```js
// ============ ADVANCED INDICATORS ============

// EMA 8/21 交叉系統
function ema(data, period) {
  const arr = emaArr(data, period);
  return arr[arr.length - 1];
}

// VWAP（日內成交量加權平均價）
function vwap(closes, highs, lows, volumes) {
  let cumVP = 0, cumV = 0;
  const result = [];
  for (let i = 0; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    cumVP += tp * volumes[i];
    cumV += volumes[i];
    result.push(cumV > 0 ? cumVP / cumV : tp);
  }
  return result[result.length - 1];
}

// Fibonacci Retracement
function fibRetrace(closes, highs, lows) {
  // Find recent swing high/low (last 60 bars)
  const period = Math.min(60, closes.length);
  const recentH = highs.slice(-period);
  const recentL = lows.slice(-period);
  const high = Math.max(...recentH);
  const low = Math.min(...recentL);
  const diff = high - low;
  
  return {
    high: high,
    low: low,
    level236: high - diff * 0.236,
    level382: high - diff * 0.382,
    level500: high - diff * 0.500,
    level618: high - diff * 0.618,
    level786: high - diff * 0.786
  };
}

// Pivot Points (Standard)
function pivotPoints(prevHigh, prevLow, prevClose) {
  const pp = (prevHigh + prevLow + prevClose) / 3;
  return {
    pp: pp,
    r1: 2 * pp - prevLow,
    r2: pp + (prevHigh - prevLow),
    r3: prevHigh + 2 * (pp - prevLow),
    s1: 2 * pp - prevHigh,
    s2: pp - (prevHigh - prevLow),
    s3: prevLow - 2 * (prevHigh - pp)
  };
}

// OBV (On-Balance Volume)
function obv(closes, volumes) {
  let result = 0;
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i-1]) result += volumes[i];
    else if (closes[i] < closes[i-1]) result -= volumes[i];
  }
  return result;
}

// Ichimoku Cloud (simplified: tenkan, kijun, senkou A/B)
function ichimoku(closes, highs, lows) {
  const n = closes.length;
  if (n < 52) return null;
  
  const periodHL = (h, l, period, idx) => {
    const hSlice = h.slice(Math.max(0, idx - period + 1), idx + 1);
    const lSlice = l.slice(Math.max(0, idx - period + 1), idx + 1);
    return (Math.max(...hSlice) + Math.min(...lSlice)) / 2;
  };
  
  const i = n - 1;
  const tenkan = periodHL(highs, lows, 9, i);   // 轉換線
  const kijun = periodHL(highs, lows, 26, i);    // 基準線
  const senkouA = (tenkan + kijun) / 2;          // 先行帶 A
  const senkouB = periodHL(highs, lows, 52, i);  // 先行帶 B
  
  return { tenkan, kijun, senkouA, senkouB, cloudTop: Math.max(senkouA, senkouB), cloudBottom: Math.min(senkouA, senkouB) };
}
```

### 整合進 `technicalAnalysis()` 和 `renderStock()`

在 `technicalAnalysis()` 函式的回傳物件中新增這些指標值：

```js
// 在 technicalAnalysis() 最後的 return 之前計算
const ema8 = ema(closes, 8), ema21 = ema(closes, 21);
const vwapV = vwap(closes, highs, lows, volumes);
const fib = fibRetrace(closes, highs, lows);
const pivot = closes.length >= 2 ? pivotPoints(highs[highs.length-2], lows[lows.length-2], closes[closes.length-2]) : null;
const obvV = obv(closes, volumes);
const ichV = ichimoku(closes, highs, lows);

// 新增 EMA8/21 交叉信號
if (ema8 && ema21) {
  if (ema8 > ema21) { sigs.push({ n: 'EMA8>EMA21 短多', t: 'b' }); score += 5; }
  else { sigs.push({ n: 'EMA8<EMA21 短空', t: 's' }); score -= 5; }
}

// Ichimoku cloud signal
if (ichV && price > ichV.cloudTop) { sigs.push({ n: '站上一目雲', t: 'b' }); score += 5; }
else if (ichV && price < ichV.cloudBottom) { sigs.push({ n: '跌破一目雲', t: 's' }); score -= 5; }
```

在回傳物件中加入：
```js
return { ...(existing fields), ema8, ema21, vwap: vwapV, fib, pivot, obv: obvV, ichimoku: ichV };
```

在 `renderStock()` 的技術指標明細表格中，新增以下行：

```js
// 在現有 table 的 </table> 之前加入
'<tr><td style="color:var(--muted)">EMA 8/21</td><td><b>' + f(ta.ema8) + ' / ' + f(ta.ema21) + '</b></td><td>' + (ta.ema8 > ta.ema21 ? '<span style="color:var(--green)">短多</span>' : '<span style="color:var(--red)">短空</span>') + '</td></tr>' +
'<tr><td style="color:var(--muted)">VWAP</td><td><b>' + f(ta.vwap) + '</b></td><td>' + (price > ta.vwap ? '<span style="color:var(--green)">站上</span>' : '<span style="color:var(--red)">跌破</span>') + '</td></tr>' +
(ta.pivot ? '<tr><td style="color:var(--muted)">Pivot</td><td colspan="2"><span style="color:var(--red)">R1:' + f(ta.pivot.r1) + '</span> <b>PP:' + f(ta.pivot.pp) + '</b> <span style="color:var(--green)">S1:' + f(ta.pivot.s1) + '</span></td></tr>' : '') +
(ta.fib ? '<tr><td style="color:var(--muted)">Fibonacci</td><td colspan="2"><span style="font-size:11px">38.2%:' + f(ta.fib.level382) + ' | 50%:' + f(ta.fib.level500) + ' | 61.8%:' + f(ta.fib.level618) + '</span></td></tr>' : '') +
(ta.ichimoku ? '<tr><td style="color:var(--muted)">一目雲</td><td><b>' + f(ta.ichimoku.tenkan) + ' / ' + f(ta.ichimoku.kijun) + '</b></td><td>' + (price > ta.ichimoku.cloudTop ? '<span style="color:var(--green)">雲上</span>' : price < ta.ichimoku.cloudBottom ? '<span style="color:var(--red)">雲下</span>' : '<span style="color:var(--yellow)">雲中</span>') + '</td></tr>' : '') +
'<tr><td style="color:var(--muted)">OBV</td><td><b>' + (ta.obv > 0 ? '+' : '') + (ta.obv / 1e6).toFixed(1) + 'M</b></td><td>' + (ta.obv > 0 ? '<span style="color:var(--green)">買方累積</span>' : '<span style="color:var(--red)">賣方累積</span>') + '</td></tr>'
```

---

## 模組 E：進階績效分析

### 頁面結構

```html
<div id="page-performance" class="page">
  <h2 style="margin-bottom:20px">📊 績效分析</h2>
  <div id="performance-content"></div>
</div>
```

### 核心邏輯

```js
function renderPerformance() {
  const j = getJ();
  const div = document.getElementById('performance-content');
  
  if (j.length < 2) {
    div.innerHTML = '<div class="card" style="text-align:center;padding:40px"><h3>尚無足夠交易紀錄</h3><p style="color:var(--muted);margin-top:8px">至少需要 2 筆交易紀錄才能分析績效。<br>前往「交易日誌」頁面新增紀錄。</p><button class="btn btn-primary" style="margin-top:16px" onclick="showPage(\'journal\')">前往交易日誌</button></div>';
    return;
  }
  
  // 計算配對交易
  const trades = pairTrades(j);
  
  if (trades.length === 0) {
    div.innerHTML = '<div class="card" style="text-align:center;padding:40px"><h3>尚無完整買賣配對</h3><p style="color:var(--muted);margin-top:8px">績效分析需要至少一組完整的買入→賣出配對紀錄。</p></div>';
    return;
  }
  
  const stats = calcPerformanceStats(trades);
  
  let html = '';
  
  // 核心統計卡片
  html += '<div class="grid4">';
  html += statCard('勝率', stats.winRate.toFixed(1) + '%', stats.winRate >= 50 ? 'green' : 'red');
  html += statCard('利潤因子', stats.profitFactor.toFixed(2), stats.profitFactor >= 1.5 ? 'green' : stats.profitFactor >= 1 ? 'yellow' : 'red');
  html += statCard('期望值', (stats.expectancy >= 0 ? '+' : '') + stats.expectancy.toFixed(2), stats.expectancy >= 0 ? 'green' : 'red');
  html += statCard('最大回撤', '-' + stats.maxDrawdown.toFixed(1) + '%', stats.maxDrawdown < 15 ? 'green' : stats.maxDrawdown < 30 ? 'yellow' : 'red');
  html += '</div>';
  
  // 詳細統計表
  html += '<div class="grid2">';
  html += '<div class="card"><h3>📈 獲利統計</h3><div class="table-wrap"><table>';
  html += '<tr><td style="color:var(--muted)">總交易次數</td><td><b>' + trades.length + '</b></td></tr>';
  html += '<tr><td style="color:var(--muted)">獲利次數</td><td style="color:var(--green)"><b>' + stats.wins + '</b></td></tr>';
  html += '<tr><td style="color:var(--muted)">虧損次數</td><td style="color:var(--red)"><b>' + stats.losses + '</b></td></tr>';
  html += '<tr><td style="color:var(--muted)">平均獲利</td><td style="color:var(--green)"><b>+' + stats.avgWin.toFixed(2) + '%</b></td></tr>';
  html += '<tr><td style="color:var(--muted)">平均虧損</td><td style="color:var(--red)"><b>' + stats.avgLoss.toFixed(2) + '%</b></td></tr>';
  html += '<tr><td style="color:var(--muted)">最大單筆獲利</td><td style="color:var(--green)"><b>+' + stats.maxWin.toFixed(2) + '%</b></td></tr>';
  html += '<tr><td style="color:var(--muted)">最大單筆虧損</td><td style="color:var(--red)"><b>' + stats.maxLoss.toFixed(2) + '%</b></td></tr>';
  html += '<tr><td style="color:var(--muted)">最大連勝</td><td><b>' + stats.maxConsecWins + '</b></td></tr>';
  html += '<tr><td style="color:var(--muted)">最大連虧</td><td><b>' + stats.maxConsecLosses + '</b></td></tr>';
  html += '</table></div></div>';
  
  // 策略對比表
  html += '<div class="card"><h3>⚔️ 策略對比</h3><div class="table-wrap"><table>';
  html += '<thead><tr><th>策略</th><th>交易數</th><th>勝率</th><th>利潤因子</th><th>總損益</th></tr></thead><tbody>';
  const stratLabels = { value: '價值投資', swing: '波段交易', day: '當沖', other: '其他' };
  ['value', 'swing', 'day', 'other'].forEach(s => {
    const st = trades.filter(t => t.strategy === s);
    if (st.length === 0) return;
    const stStats = calcPerformanceStats(st);
    html += '<tr><td>' + stratLabels[s] + '</td><td>' + st.length + '</td>';
    html += '<td style="color:' + (stStats.winRate >= 50 ? 'var(--green)' : 'var(--red)') + '">' + stStats.winRate.toFixed(1) + '%</td>';
    html += '<td>' + stStats.profitFactor.toFixed(2) + '</td>';
    html += '<td style="color:' + (stStats.totalPnl >= 0 ? 'var(--green)' : 'var(--red)') + '">' + (stStats.totalPnl >= 0 ? '+' : '') + stStats.totalPnl.toFixed(2) + '%</td></tr>';
  });
  html += '</tbody></table></div></div>';
  html += '</div>';
  
  // 權益曲線
  html += '<div class="card"><h3>📈 權益曲線</h3><div id="equity-curve" class="chart-container" style="height:250px"></div></div>';
  
  // 日曆熱力圖
  html += '<div class="card"><h3>📅 交易日曆熱力圖</h3><div id="calendar-heatmap" style="display:flex;flex-wrap:wrap;gap:4px"></div></div>';
  
  // R 倍數分布
  html += '<div class="card"><h3>📊 R 倍數分布</h3><div id="r-distribution" style="display:flex;align-items:flex-end;gap:4px;height:150px;padding:20px 0"></div></div>';
  
  div.innerHTML = html;
  
  // Render charts
  setTimeout(() => {
    renderEquityCurve(trades);
    renderCalendarHeatmap(trades);
    renderRDistribution(trades);
  }, 50);
}

function statCard(label, value, color) {
  const colorVar = color === 'green' ? 'var(--green)' : color === 'red' ? 'var(--red)' : 'var(--yellow)';
  return '<div class="card" style="text-align:center"><div style="font-size:12px;color:var(--muted);margin-bottom:4px">' + label + '</div><div style="font-size:28px;font-weight:700;color:' + colorVar + '">' + value + '</div></div>';
}

function pairTrades(journal) {
  // 配對買入→賣出，計算每筆交易的損益
  const buys = {};
  const trades = [];
  
  // Sort by date
  const sorted = [...journal].sort((a, b) => new Date(a.date) - new Date(b.date));
  
  sorted.forEach(e => {
    if (e.action === 'buy') {
      if (!buys[e.ticker]) buys[e.ticker] = [];
      buys[e.ticker].push(e);
    }
    if (e.action === 'sell' && buys[e.ticker] && buys[e.ticker].length > 0) {
      const buy = buys[e.ticker].shift();
      const pnlPct = ((e.price - buy.price) / buy.price) * 100;
      const pnlAmt = (e.price - buy.price) * Math.min(buy.qty, e.qty);
      trades.push({
        ticker: e.ticker,
        buyDate: buy.date,
        sellDate: e.date,
        buyPrice: buy.price,
        sellPrice: e.price,
        qty: Math.min(buy.qty, e.qty),
        pnlPct: pnlPct,
        pnlAmt: pnlAmt,
        strategy: buy.strategy || 'other',
        isWin: pnlPct > 0
      });
    }
  });
  
  return trades;
}

function calcPerformanceStats(trades) {
  if (trades.length === 0) return { winRate: 0, profitFactor: 0, expectancy: 0, maxDrawdown: 0, wins: 0, losses: 0, avgWin: 0, avgLoss: 0, maxWin: 0, maxLoss: 0, maxConsecWins: 0, maxConsecLosses: 0, totalPnl: 0 };
  
  const winTrades = trades.filter(t => t.pnlPct > 0);
  const lossTrades = trades.filter(t => t.pnlPct <= 0);
  
  const totalWinPct = winTrades.reduce((s, t) => s + t.pnlPct, 0);
  const totalLossPct = lossTrades.reduce((s, t) => s + Math.abs(t.pnlPct), 0);
  
  const winRate = (winTrades.length / trades.length) * 100;
  const profitFactor = totalLossPct > 0 ? totalWinPct / totalLossPct : totalWinPct > 0 ? 999 : 0;
  const avgWin = winTrades.length > 0 ? totalWinPct / winTrades.length : 0;
  const avgLoss = lossTrades.length > 0 ? -(totalLossPct / lossTrades.length) : 0;
  const expectancy = (winRate / 100) * avgWin + ((100 - winRate) / 100) * avgLoss;
  
  const maxWin = winTrades.length > 0 ? Math.max(...winTrades.map(t => t.pnlPct)) : 0;
  const maxLoss = lossTrades.length > 0 ? Math.min(...lossTrades.map(t => t.pnlPct)) : 0;
  
  // Max consecutive wins/losses
  let consecWins = 0, consecLosses = 0, maxCW = 0, maxCL = 0;
  trades.forEach(t => {
    if (t.isWin) { consecWins++; consecLosses = 0; maxCW = Math.max(maxCW, consecWins); }
    else { consecLosses++; consecWins = 0; maxCL = Math.max(maxCL, consecLosses); }
  });
  
  // Max drawdown
  let equity = 100, peak = 100, maxDD = 0;
  trades.forEach(t => {
    equity *= (1 + t.pnlPct / 100);
    peak = Math.max(peak, equity);
    const dd = (peak - equity) / peak * 100;
    maxDD = Math.max(maxDD, dd);
  });
  
  return {
    winRate, profitFactor, expectancy, maxDrawdown: maxDD,
    wins: winTrades.length, losses: lossTrades.length,
    avgWin, avgLoss, maxWin, maxLoss: Math.abs(maxLoss),
    maxConsecWins: maxCW, maxConsecLosses: maxCL,
    totalPnl: trades.reduce((s, t) => s + t.pnlPct, 0)
  };
}
```

### 權益曲線圖

```js
function renderEquityCurve(trades) {
  const el = document.getElementById('equity-curve');
  if (!el || !trades.length) return;
  
  const ch = LightweightCharts.createChart(el, {
    width: el.clientWidth, height: 250,
    layout: { background: { color: '#131928' }, textColor: '#7a8ba5' },
    grid: { vertLines: { color: '#1e2a3a' }, horzLines: { color: '#1e2a3a' } },
    rightPriceScale: { borderColor: '#1e2a3a' },
    timeScale: { borderColor: '#1e2a3a' }
  });
  
  let equity = 100;
  const data = trades.map(t => {
    equity *= (1 + t.pnlPct / 100);
    return {
      time: Math.floor(new Date(t.sellDate).getTime() / 1000),
      value: equity
    };
  });
  
  // Deduplicate by time and sort
  const unique = {};
  data.forEach(d => { unique[d.time] = d; });
  const sorted = Object.values(unique).sort((a, b) => a.time - b.time);
  
  const line = ch.addLineSeries({ color: equity >= 100 ? '#10b981' : '#ef4444', lineWidth: 2 });
  line.setData(sorted);
  
  // Add baseline at 100
  ch.addLineSeries({ color: '#7a8ba5', lineWidth: 1, lineStyle: 2 }).setData(sorted.map(d => ({ time: d.time, value: 100 })));
  
  ch.timeScale().fitContent();
  new ResizeObserver(() => ch.applyOptions({ width: el.clientWidth })).observe(el);
}
```

### 日曆熱力圖和 R 倍數分布

```js
function renderCalendarHeatmap(trades) {
  const el = document.getElementById('calendar-heatmap');
  if (!el) return;
  
  // Group by date
  const byDate = {};
  trades.forEach(t => {
    const d = t.sellDate;
    if (!byDate[d]) byDate[d] = 0;
    byDate[d] += t.pnlPct;
  });
  
  let html = '';
  Object.keys(byDate).sort().forEach(date => {
    const pnl = byDate[date];
    const intensity = Math.min(Math.abs(pnl) / 10, 1);
    let bg;
    if (pnl > 0) bg = 'rgba(16,185,129,' + (0.2 + intensity * 0.8) + ')';
    else if (pnl < 0) bg = 'rgba(239,68,68,' + (0.2 + intensity * 0.8) + ')';
    else bg = 'rgba(127,140,141,0.3)';
    
    html += '<div style="width:28px;height:28px;background:' + bg + ';border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:8px;color:#fff;cursor:help" title="' + date + ': ' + (pnl >= 0 ? '+' : '') + pnl.toFixed(1) + '%">' + date.slice(8) + '</div>';
  });
  
  el.innerHTML = html || '<span style="color:var(--muted)">尚無交易日期資料</span>';
}

function renderRDistribution(trades) {
  const el = document.getElementById('r-distribution');
  if (!el || !trades.length) return;
  
  // Calculate R-multiples (approximate: use avg loss as 1R)
  const losses = trades.filter(t => t.pnlPct < 0);
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length) : 5;
  
  const rValues = trades.map(t => t.pnlPct / avgLoss);
  
  // Create histogram buckets
  const buckets = {};
  for (let r = -5; r <= 5; r += 0.5) {
    const key = r.toFixed(1);
    buckets[key] = 0;
  }
  
  rValues.forEach(r => {
    const clamped = Math.max(-5, Math.min(5, r));
    const key = (Math.round(clamped * 2) / 2).toFixed(1);
    if (buckets[key] !== undefined) buckets[key]++;
  });
  
  const maxCount = Math.max(1, ...Object.values(buckets));
  
  let html = '';
  Object.entries(buckets).forEach(([r, count]) => {
    const rNum = parseFloat(r);
    const height = (count / maxCount) * 120;
    const color = rNum >= 0 ? 'var(--green)' : 'var(--red)';
    const opacity = count > 0 ? 1 : 0.1;
    
    html += '<div style="display:flex;flex-direction:column;align-items:center;flex:1;min-width:12px;opacity:' + opacity + '">' +
      '<div style="width:100%;height:' + height + 'px;background:' + color + ';border-radius:2px 2px 0 0;min-height:2px"></div>' +
      (rNum % 1 === 0 ? '<div style="font-size:8px;color:var(--muted);margin-top:2px">' + r + 'R</div>' : '') +
      '</div>';
  });
  
  el.innerHTML = html;
}
```

---

## 模組 G：短線交易教學中心

### 頁面結構

```html
<div id="page-education" class="page">
  <h2 style="margin-bottom:20px">📚 短線交易教學</h2>
  <div id="education-content"></div>
</div>
```

### 教學內容

```js
function renderEducation() {
  const div = document.getElementById('education-content');
  
  div.innerHTML = `
  <div class="tab-bar" id="edu-tabs">
    <button class="active" onclick="showEduTab('ta')">技術分析進階</button>
    <button onclick="showEduTab('patterns')">K線型態圖解</button>
    <button onclick="showEduTab('psychology')">交易心理學</button>
    <button onclick="showEduTab('money')">資金管理</button>
  </div>
  <div id="edu-detail"></div>
  `;
  
  showEduTab('ta');
}
```

以下是 `showEduTab()` 函式的完整實作。由於教學內容非常長，以下提供每個 tab 的結構和關鍵內容。**請完整實作每個 tab 的全部內容，不要省略**。

```js
function showEduTab(tab) {
  document.querySelectorAll('#edu-tabs button').forEach((b, i) =>
    b.classList.toggle('active', i === ['ta','patterns','psychology','money'].indexOf(tab))
  );
  
  const eduContent = {
    ta: getTaEducation(),
    patterns: getPatternsEducation(),
    psychology: getPsychologyEducation(),
    money: getMoneyEducation()
  };
  
  document.getElementById('edu-detail').innerHTML = eduContent[tab];
}
```

#### 技術分析進階

```js
function getTaEducation() {
  return `
  <div class="card edu-card">
    <h3>📊 支撐與壓力的本質</h3>
    <p><span class="edu-term">支撐（Support）</span></p>
    <p>支撐不是一條線，是一個<b>價格區域</b>，在這個區域中，買方的力量開始大於賣方。</p>
    <p><b>為什麼支撐有效？</b></p>
    <p>① 過去在此價位買入的人「不想賠錢」→ 不願賣出 → 賣壓減少</p>
    <p>② 過去在此價位錯過的人「想補回」→ 願意買入 → 買盤增加</p>
    <p>③ 機構法人的大量限價買單堆積在此區域</p>
    <p>④ 心理數字關卡（如 100、50、整數位）</p>
    <p style="margin-top:12px"><span class="edu-term">壓力（Resistance）</span></p>
    <p>壓力是相反邏輯：過去在此價位被套牢的人「想解套」→ 價格到了就賣 → 賣壓增加。</p>
    <p style="margin-top:12px"><span class="edu-term">支撐壓力互換原則</span></p>
    <p>當支撐被跌破後，它變成新的壓力。當壓力被突破後，它變成新的支撐。</p>
    <p><b>因為：</b>原本在支撐買入的人現在被套了，當價格反彈回這個位置時，他們「想解套」而賣出，形成賣壓。</p>
  </div>
  
  <div class="card edu-card">
    <h3>📈 趨勢結構（Market Structure）</h3>
    <p><span class="edu-term">上升趨勢</span>：Higher Highs (HH) + Higher Lows (HL)</p>
    <p>每一波高點都比前一波高，每一波低點也比前一波低點高。只要這個結構維持，趨勢不變。</p>
    <p style="margin-top:8px"><span class="edu-term">下降趨勢</span>：Lower Highs (LH) + Lower Lows (LL)</p>
    <p>每一波高點都比前一波低，每一波低點也比前一波低。</p>
    <p style="margin-top:8px"><span class="edu-term">趨勢反轉信號（Break of Structure, BOS）</span></p>
    <p>上升趨勢中，如果價格跌破前一個 Higher Low → 趨勢可能反轉。</p>
    <p>下降趨勢中，如果價格突破前一個 Lower High → 趨勢可能反轉。</p>
    <p style="margin-top:8px"><b>Schwartz 的實戰應用：</b>他不預測反轉，而是等「結構破壞」確認後才行動。「我不試圖抓頂部或底部，我等趨勢確認後順勢交易。」</p>
  </div>
  
  <div class="card edu-card">
    <h3>📊 量價關係深度解析</h3>
    <p><span class="edu-term">量價配合八法則</span></p>
    <p>① <b>量增價漲</b>：健康上漲，趨勢延續（最強信號）</p>
    <p>② <b>量縮價漲</b>：上漲無力，可能見頂（警告信號）</p>
    <p>③ <b>量增價跌</b>：恐慌拋售，可能加速下跌（危險信號）</p>
    <p>④ <b>量縮價跌</b>：下跌動能衰竭，可能觸底（觀察信號）</p>
    <p>⑤ <b>天量天價</b>：大量出貨，頂部確認</p>
    <p>⑥ <b>地量地價</b>：無人交易，底部特徵</p>
    <p>⑦ <b>突破放量</b>：突破有效的確認（量 > 1.5 倍均量）</p>
    <p>⑧ <b>突破縮量</b>：假突破的警告</p>
    <p style="margin-top:12px"><b>Steinhardt 的觀察：</b>「成交量是市場真正的情緒。價格可以被操縱，但成交量不會騙人。」</p>
  </div>
  `;
}
```

#### K 線型態圖解

```js
function getPatternsEducation() {
  return `
  <div class="card edu-card">
    <h3>🕯️ 單 K 線型態</h3>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px;margin-top:12px">
      
      <div style="background:var(--bg);padding:16px;border-radius:8px;text-align:center">
        <svg width="60" height="100" viewBox="0 0 60 100"><line x1="30" y1="10" x2="30" y2="30" stroke="#7a8ba5" stroke-width="2"/><rect x="15" y="30" width="30" height="40" fill="#10b981" rx="2"/><line x1="30" y1="70" x2="30" y2="95" stroke="#7a8ba5" stroke-width="2"/></svg>
        <div style="font-weight:700;margin-top:8px">錘子線（Hammer）</div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px">下影線 ≥ 實體 2 倍，出現在下跌趨勢底部。<b style="color:var(--green)">看漲反轉信號。</b></div>
      </div>
      
      <div style="background:var(--bg);padding:16px;border-radius:8px;text-align:center">
        <svg width="60" height="100" viewBox="0 0 60 100"><line x1="30" y1="5" x2="30" y2="30" stroke="#7a8ba5" stroke-width="2"/><rect x="15" y="30" width="30" height="40" fill="#ef4444" rx="2"/><line x1="30" y1="70" x2="30" y2="95" stroke="#7a8ba5" stroke-width="2"/></svg>
        <div style="font-weight:700;margin-top:8px">吊人線（Hanging Man）</div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px">形態同錘子但出現在上漲趨勢頂部。<b style="color:var(--red)">看跌反轉信號。</b></div>
      </div>
      
      <div style="background:var(--bg);padding:16px;border-radius:8px;text-align:center">
        <svg width="60" height="100" viewBox="0 0 60 100"><line x1="30" y1="10" x2="30" y2="45" stroke="#7a8ba5" stroke-width="2"/><rect x="15" y="45" width="30" height="5" fill="#7a8ba5" rx="1"/><line x1="30" y1="50" x2="30" y2="90" stroke="#7a8ba5" stroke-width="2"/></svg>
        <div style="font-weight:700;margin-top:8px">十字星（Doji）</div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px">開盤≈收盤，上下影線。<b>代表市場猶豫不決</b>，可能發生反轉。</div>
      </div>
      
      <div style="background:var(--bg);padding:16px;border-radius:8px;text-align:center">
        <svg width="80" height="100" viewBox="0 0 80 100"><rect x="5" y="20" width="25" height="60" fill="#ef4444" rx="2"/><rect x="35" y="10" width="35" height="80" fill="#10b981" rx="2"/></svg>
        <div style="font-weight:700;margin-top:8px">看漲吞噬（Bullish Engulfing）</div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px">大陽線完全覆蓋前一根陰線。<b style="color:var(--green)">強烈看漲反轉。</b></div>
      </div>
      
      <div style="background:var(--bg);padding:16px;border-radius:8px;text-align:center">
        <svg width="80" height="100" viewBox="0 0 80 100"><rect x="5" y="10" width="25" height="60" fill="#10b981" rx="2"/><rect x="35" y="5" width="35" height="85" fill="#ef4444" rx="2"/></svg>
        <div style="font-weight:700;margin-top:8px">看跌吞噬（Bearish Engulfing）</div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px">大陰線完全覆蓋前一根陽線。<b style="color:var(--red)">強烈看跌反轉。</b></div>
      </div>
      
      <div style="background:var(--bg);padding:16px;border-radius:8px;text-align:center">
        <svg width="60" height="100" viewBox="0 0 60 100"><line x1="30" y1="5" x2="30" y2="15" stroke="#7a8ba5" stroke-width="2"/><rect x="15" y="15" width="30" height="50" fill="#10b981" rx="2"/><line x1="30" y1="65" x2="30" y2="70" stroke="#7a8ba5" stroke-width="2"/></svg>
        <div style="font-weight:700;margin-top:8px">大陽線（Marubozu）</div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px">實體長、影線短或無。<b style="color:var(--green)">買方完全控制，強烈看漲。</b></div>
      </div>
    </div>
  </div>
  
  <div class="card edu-card">
    <h3>📐 經典反轉型態</h3>
    
    <div style="margin-bottom:20px">
      <p><span class="edu-term">頭肩頂（Head and Shoulders）</span></p>
      <svg width="300" height="120" viewBox="0 0 300 120" style="margin:12px 0">
        <polyline points="10,90 50,60 90,80 150,20 210,80 250,50 290,90" fill="none" stroke="var(--accent)" stroke-width="2"/>
        <line x1="60" y1="80" x2="230" y2="80" stroke="var(--red)" stroke-width="1.5" stroke-dasharray="4,4"/>
        <text x="150" y="15" fill="var(--muted)" font-size="10" text-anchor="middle">頭</text>
        <text x="50" y="55" fill="var(--muted)" font-size="10" text-anchor="middle">左肩</text>
        <text x="250" y="45" fill="var(--muted)" font-size="10" text-anchor="middle">右肩</text>
        <text x="260" y="78" fill="var(--red)" font-size="10">頸線</text>
      </svg>
      <p>三個高點中間最高。當價格跌破頸線，確認反轉。</p>
      <p><b>目標價</b> = 頸線 - (頭部到頸線的距離)</p>
    </div>
    
    <div style="margin-bottom:20px">
      <p><span class="edu-term">雙重頂 / 雙重底（Double Top / Bottom）</span></p>
      <svg width="300" height="120" viewBox="0 0 300 120" style="margin:12px 0">
        <polyline points="10,90 80,20 150,70 220,20 290,90" fill="none" stroke="var(--accent)" stroke-width="2"/>
        <line x1="100" y1="70" x2="200" y2="70" stroke="var(--red)" stroke-width="1.5" stroke-dasharray="4,4"/>
        <text x="80" y="15" fill="var(--muted)" font-size="10" text-anchor="middle">第一頂</text>
        <text x="220" y="15" fill="var(--muted)" font-size="10" text-anchor="middle">第二頂</text>
        <text x="220" y="68" fill="var(--red)" font-size="10">頸線</text>
      </svg>
      <p>價格兩次測試同一高點都無法突破（M 型態）。跌破中間低點（頸線）確認反轉。</p>
    </div>
    
    <div>
      <p><span class="edu-term">三角形整理（Triangle）</span></p>
      <svg width="300" height="120" viewBox="0 0 300 120" style="margin:12px 0">
        <line x1="10" y1="20" x2="250" y2="55" stroke="var(--red)" stroke-width="1.5" stroke-dasharray="4,4"/>
        <line x1="10" y1="100" x2="250" y2="55" stroke="var(--green)" stroke-width="1.5" stroke-dasharray="4,4"/>
        <polyline points="10,20 40,90 80,30 120,80 160,40 200,70 240,55 290,25" fill="none" stroke="var(--accent)" stroke-width="2"/>
        <text x="265" y="20" fill="var(--green)" font-size="10">突破方向</text>
      </svg>
      <p>高點遞降 + 低點遞升 = 對稱三角形。突破方向是交易方向。通常在三角形 2/3 處突破。</p>
    </div>
  </div>
  `;
}
```

#### 交易心理學

```js
function getPsychologyEducation() {
  return `
  <div class="card edu-card">
    <h3>🧠 FOMO（Fear Of Missing Out）錯失恐懼</h3>
    <p><b>症狀：</b>看到一檔股票大漲，覺得「再不買就來不及了」，衝動進場。</p>
    <p style="margin-top:8px"><b>為什麼危險：</b></p>
    <p>① 你在情緒最高點（而非最佳價位）進場</p>
    <p>② 你沒有交易計畫（沒設停損、不知道目標價）</p>
    <p>③ 追高買入的人是最後的買方，你可能買在頂部</p>
    <p style="margin-top:8px"><b>Schwartz 的解法：</b></p>
    <p>「市場每天都有新機會。錯過這一檔不會死，但追高進場可能會讓你的帳戶死掉。」</p>
    <p>✅ 紀律：如果你沒有在掃描/分析階段就選中這檔股票，盤中不要追。</p>
    <p>✅ 記在明天的觀察清單中，等回調再進場。</p>
  </div>
  
  <div class="card edu-card">
    <h3>🎰 過度交易（Overtrading）</h3>
    <p><b>自我診斷：</b></p>
    <p>☐ 每天交易超過 3 筆</p>
    <p>☐ 在沒有明確信號時仍然進場</p>
    <p>☐ 虧損後急著想「賺回來」</p>
    <p>☐ 覺得不交易就是在浪費時間</p>
    <p>☐ 交易時感到興奮/焦慮而非冷靜</p>
    <p style="margin-top:8px">如果上述打勾超過 2 項，你可能在過度交易。</p>
    <p style="margin-top:8px"><b>Steinhardt 的原則：</b></p>
    <p>「The best traders make money by <b>not</b> trading.」最好的交易者是透過「不交易」來賺錢的。</p>
    <p>✅ 設定每日最大交易次數（建議 1-3 筆）</p>
    <p>✅ 連虧 2 筆後暫停交易，離開螢幕至少 30 分鐘</p>
    <p>✅ 每筆交易前問自己：「這筆交易有計畫嗎？」</p>
  </div>
  
  <div class="card edu-card">
    <h3>😤 虧損後的心理恢復</h3>
    <p><span class="edu-term">報復性交易的循環</span></p>
    <p>虧損 → 沮喪 → 想立刻賺回來 → 加大倉位 → 不設停損 → 更大虧損 → 崩潰</p>
    <p style="margin-top:8px"><b>打破循環的方法：</b></p>
    <p>① <b>縮小倉位</b>：虧損後下一筆交易用平常一半的倉位。這是 Schwartz 的鐵律。</p>
    <p>② <b>回到基本面</b>：重新檢視你的交易計畫，是執行問題還是策略問題？</p>
    <p>③ <b>分離情緒和決策</b>：你的帳戶不認識你。市場不會因為你虧了就同情你。</p>
    <p>④ <b>看長期數據</b>：查看你的績效分析頁面，一筆虧損在長期來看微不足道。</p>
    <p style="margin-top:12px"><b>Schwartz 的名言：</b>「我從來不和市場爭論。如果我錯了，我立刻出場。沒有自尊心的問題。」</p>
  </div>
  
  <div class="card edu-card">
    <h3>💬 Schwartz & Steinhardt 的交易哲學</h3>
    <p style="margin-bottom:12px"><span class="edu-term">Marty Schwartz</span>（《Pit Bull》作者，冠軍交易員）</p>
    <p>「最重要的事情是資金管理、資金管理、資金管理。」</p>
    <p>「我的勝率大約 55%。我賺錢的秘密不是常常對，而是我對的時候賺得多，錯的時候賠得少。」</p>
    <p>「永遠不要在虧損的部位上加碼。這是業餘者的死因。」</p>
    <p style="margin-top:12px"><span class="edu-term">Michael Steinhardt</span>（對沖基金傳奇）</p>
    <p>「Variant Perception：找到市場共識錯誤的地方。當所有人都看多時，問問誰還沒買？如果答案是『幾乎沒人沒買』，那上漲空間就有限了。」</p>
    <p>「交易的本質是機率遊戲。你不需要每次都對，但你需要確保每次對的時候利潤夠大。」</p>
    <p>「我從不告訴別人我的部位。一旦你公開了，你的自尊就綁在上面了。」</p>
  </div>
  `;
}
```

#### 資金管理教學

```js
function getMoneyEducation() {
  return `
  <div class="card edu-card">
    <h3>💰 1% 法則：為什麼能救你的命</h3>
    <p><span class="edu-term">核心原則</span>：每筆交易的最大虧損不超過總資金的 1%。</p>
    <p style="margin-top:8px"><b>數學證明：</b></p>
    <p>假設你有 100 萬資金，每次最多虧 1 萬（1%）。</p>
    <p>即使你連虧 <b>10 次</b>，你的資金仍有 ~90.4 萬（虧損 9.6%）。</p>
    <p>只要你有一個正期望值的策略，10 次連虧後你仍然可以恢復。</p>
    <p style="margin-top:8px">但如果你每次虧 <b>10%</b>，連虧 10 次後你只剩 34.9 萬——幾乎需要翻三倍才能回本。</p>
    <p style="margin-top:12px"><b>1% 法則不限制你的倉位大小</b>，它限制的是你的<b>虧損距離</b>。</p>
    <p>倉位 = 最大虧損額 ÷ (進場價 - 停損價)</p>
    <p>→ 去本站的「風控中心」頁面可以自動計算。</p>
  </div>
  
  <div class="card edu-card">
    <h3>📐 Kelly Criterion 詳解</h3>
    <p><span class="edu-term">公式</span>：f* = W - (1-W)/R</p>
    <p>f* = 最佳倉位比例</p>
    <p>W = 勝率</p>
    <p>R = 平均獲利 / 平均虧損</p>
    <p style="margin-top:8px"><b>例子：</b>勝率 55%，平均賺 $150 / 平均虧 $100（R=1.5）</p>
    <p>f* = 0.55 - (0.45/1.5) = 0.55 - 0.30 = <b>0.25</b>（25%）</p>
    <p style="margin-top:8px"><b>實務重點：</b></p>
    <p>① Full Kelly 的波動性很大，建議使用 <b>Half Kelly</b>（12.5%）</p>
    <p>② Kelly 假設你精確知道勝率和盈虧比。現實中你只有估計值，所以要保守。</p>
    <p>③ Kelly 值為負 → 這個策略沒有正期望值，不應該交易。</p>
    <p>→ 去本站的「風控中心」頁面可以自動計算你的 Kelly 值。</p>
  </div>
  
  <div class="card edu-card">
    <h3>🏗️ 金字塔加碼法（Pyramiding）</h3>
    <p><span class="edu-term">核心概念</span>：在獲利的部位上加碼，而非虧損的部位。</p>
    <p style="margin-top:8px"><b>標準做法（三次加碼）：</b></p>
    <p>① 初始倉位：40%（在進場價買入）</p>
    <p>② 第一次加碼：30%（股價上漲 1R 後加碼）</p>
    <p>③ 第二次加碼：20%（股價上漲 2R 後加碼）</p>
    <p>④ 剩餘 10%：備用或不使用</p>
    <p style="margin-top:8px"><b>關鍵紀律：</b></p>
    <p>✅ 每次加碼後，將停損移到上一次加碼的價位</p>
    <p>✅ 永遠不在虧損的部位加碼（這叫「攤平」，是虧損擴大器）</p>
    <p>✅ 加碼的數量必須遞減（不是等量加碼）</p>
    <p style="margin-top:12px"><b>Schwartz：</b>「我只在勝利的時候加大注碼。這就像是賭場裡用贏來的錢下注——你的風險永遠是有限的。」</p>
  </div>
  
  <div class="card edu-card">
    <h3>🔄 反馬丁格爾策略（Anti-Martingale）</h3>
    <p><span class="edu-term">馬丁格爾（絕對不要用）</span>：虧損後加倍下注。</p>
    <p>→ 這是賭場策略，在有限資金下 <b>必然爆倉</b>。</p>
    <p style="margin-top:8px"><span class="edu-term">反馬丁格爾（推薦）</span>：獲利後增加倉位，虧損後減少倉位。</p>
    <p style="margin-top:8px"><b>實作方式：</b></p>
    <p>① 連續獲利 3 次 → 下一筆倉位可增加 20-50%</p>
    <p>② 連續虧損 2 次 → 下一筆倉位減少 50%</p>
    <p>③ 當回撤超過 10% → 暫停交易，回顧策略</p>
    <p style="margin-top:8px"><b>邏輯：</b>連勝時可能處於「順手期」（策略與市場狀態匹配），應該把握。連虧時可能是市場環境改變了，應該保護資金。</p>
  </div>
  `;
}
```

---

## CSS 新增

在現有 `<style>` 的結尾 `</style>` 之前，新增以下 CSS（如果有些 class 已存在則跳過）：

```css
/* Scanner watchlist alert flash */
@keyframes alertFlash {
  0%, 100% { border-color: var(--yellow); }
  50% { border-color: var(--accent); box-shadow: 0 0 20px rgba(59,130,246,0.3); }
}
.alert-flash {
  animation: alertFlash 1s infinite;
}
```

---

## 最終檢查清單

完成所有修改後，請確認：

1. **PAGES 陣列** 已更新為 12 個頁面
2. **sidebar 和 mobile-nav** 各有 12 個按鈕
3. **showPage()** 中有所有新頁面的 init 呼叫
4. **所有新函式** 都已定義且不與現有函式名衝突
5. **localStorage key** 不與現有的 `stock-journal` 衝突（新增 `scanner-watchlist`）
6. **SP500_TICKERS** 實際包含 ~500+ 檔股票
7. **TW_SCAN_POOL** 實際包含 ~200+ 檔台股
8. **batchQuote()** 函式有正確的 error handling
9. **所有 SVG 圖解** 在 K 線型態教學中正確渲染
10. **手機版排版** 正確（mobile-nav 新按鈕可滾動）
11. **多時間框架切換** 在 renderStock 和 renderBond 中都有
12. **進階指標** 在 technicalAnalysis() 的 return 物件中
13. **權益曲線圖** 使用已載入的 Lightweight Charts 庫
14. **掃描器** 在頁面離開時停止定時器（在 showPage 中加入 cleanup）

---

## 額外注意事項

- 所有文字使用**繁體中文**
- 所有金額顯示根據市場自動切換 NT$ 或 $
- 不新增任何外部依賴（只用現有的 Lightweight Charts + 原生 JS）
- 保持與現有 UI 風格完全一致（深色主題、CSS variables、相同的 card/table/tag 組件）
- 所有程式碼寫在 `<script>` 標籤內，不新增外部 JS 檔案
- 在 `// ============ INIT ============` 區塊確認初始化不會因新增的頁面而報錯
