# Stock Analysis Site — Comprehensive Improvement Plan

> Author: Opus 4.7 deep analysis
> Implementer: Sonnet (read this plan thoroughly before starting)
> Created: 2026-05-15
> Goal: Transform site from "reactive TA viewer" into "alpha-generating predictive system"

## Background

The user (sophisticated trader) bought ONDS pre-earnings based on fundamental conviction. Stock jumped 20% on earnings beat. The site:
- Did not have ONDS in any ranking
- Showed "do not buy" before earnings
- Showed "buy" after the 20% move (hindsight bias)

Root cause: the site is structurally a "follow-existing-momentum" tool, not a "discover-before-it-moves" tool. To beat the market, we need to add **catalyst discovery, backtest credibility, and predictive signal stacking**.

---

## Architecture Overview

| Layer | Current State | After Plan |
|-------|--------------|------------|
| Universe | ~150 hardcoded tickers | Russell 2000 + dynamic discovery (~2500) |
| Signals | Pure TA reactive | TA + catalysts + sentiment + insider |
| Validation | None | Rolling 252-day backtest per signal |
| AI Layer | Synthesizes existing TA | Multi-source narrative + catalyst integration |
| UX | Information buried | Catalyst radar as homepage |

---

## PHASE 1 — Foundation (MUST DO FIRST, blocks all other phases)

### 1.1 Expand scan universe

**File:** `scripts/scan.js`

**Current:** Hardcoded `SP500` (~500) + `GROWTH_EXTENDED` (~80) + `DISCOVERY_POOL` (~150) + 3 screener calls.

**Change:** Add dynamic universe expansion via additional Yahoo screeners:
```javascript
const ADDITIONAL_SCREENERS = [
  'most_actives',           // 50 most active
  'undervalued_growth',     // value+growth combo
  'aggressive_small_caps',  // small cap growth
  'undervalued_large_caps',
  'high_returns_value',
  '52_week_high_breakouts', // CRITICAL — catches stocks breaking out
];
```

Plus add a **persistent "discovery memory"** — any ticker that ever appeared in any screener over the past 30 days stays in the universe. Stored in `data/universe_memory.json`:
```json
{
  "tickers": {
    "ONDS": { "firstSeen": "2026-04-15", "lastSeen": "2026-05-14", "sources": ["small_cap_gainers"] }
  }
}
```

Each scan: load memory, add new tickers from current screeners, drop tickers not seen in 30 days. Target universe size: **1500-2500 unique tickers**.

**Acceptance:** Universe size logged at scan start should be ≥ 1500.

### 1.2 Fix sector mapping with Yahoo `assetProfile`

**File:** `scripts/scan.js`

**Current:** Static `SECTOR_MAP` of ~120 tickers → fragile, wrong (crypto miners → XLF).

**Change:** Build sector cache via Yahoo `quoteSummary` modules:
```javascript
async function getSectorInfo(symbol) {
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=assetProfile,summaryProfile`;
  const data = await yfFetch(url);
  const profile = data?.quoteSummary?.result?.[0]?.assetProfile;
  return {
    sector:   profile?.sector,
    industry: profile?.industry,
  };
}

// Map Yahoo sector → ETF
const SECTOR_TO_ETF = {
  'Technology':         'XLK',  // refined by industry below
  'Communication Services': 'XLC',
  'Consumer Cyclical':  'XLY',
  'Consumer Defensive': 'XLP',
  'Financial Services': 'XLF',
  'Healthcare':         'XLV',
  'Industrials':        'XLI',
  'Energy':             'XLE',
  'Basic Materials':    'XLB',
  'Real Estate':        'XLRE',
  'Utilities':          'XLU',
};

const INDUSTRY_TO_ETF = {  // higher precision
  'Semiconductors':           'SMH',
  'Software—Application':     'IGV',
  'Software—Infrastructure':  'IGV',
  'Biotechnology':            'IBB',
  'Aerospace & Defense':      'XAR',
  'Gold':                     'GDX',
  'Silver':                   'GDX',
  'Solar':                    'TAN',
  // ...
};
```

Cache sector lookups in `data/sector_cache.json` (1-year TTL — rarely changes). On scan, only fetch sector for tickers without cache entry.

**Acceptance:** `sectorRS` should be non-null for ≥ 90% of leaders (currently ~24%).

### 1.3 Add `opens` and richer OHLC to scan output

**File:** `scripts/scan.js`

`getOHLCV` should also return `opens` (already in Yahoo response). Useful for gap analysis later.

### 1.4 Add earnings dates + short interest to scan

**File:** `scripts/scan.js`

For each candidate that passes the leader/discovery filter, fetch `quoteSummary` modules:
```javascript
modules: 'calendarEvents,defaultKeyStatistics,upgradeDowngradeHistory,recommendationTrend,earningsHistory'
```

Add to output record:
```javascript
{
  ...existing,
  earningsDate:     unix timestamp or null,
  daysToEarnings:   number or null,
  shortPctOfFloat:  number or null,
  shortRatio:       number or null,         // days to cover
  recentUpgrades:   [{ firm, action, date }, ...] up to 3,
  surpriseHistory:  [{ qtr, actual, estimate, surprisePct }, ...] last 4 quarters,
}
```

**Performance note:** This adds ~2 API calls per leader/discovery. Cache in `data/quote_cache.json` (24h TTL).

**Acceptance:** `daysToEarnings` populated for ≥ 80% of leaders.

---

## PHASE 2 — Catalyst Layer (THE killer feature)

### 2.1 Insider buying detection (SEC EDGAR)

**New file:** `scripts/insider_scan.js`

SEC EDGAR provides Form 4 (insider transactions) in machine-readable format:
```
https://efts.sec.gov/LATEST/search-index?q=%22Form%204%22&forms=4&dateRange=custom&startdt=2026-04-15&enddt=2026-05-15&ciks=<CIK>
```

Or use the simpler index: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=<CIK>&type=4&dateb=&owner=include&count=40`

**Approach:** For each ticker in the scan universe, look up its CIK (we'll need a static CIK mapping — fetch once from SEC's `company_tickers.json`), then check recent Form 4 filings in the past 30 days.

**Cluster buying** = ≥ 2 insiders buying in past 30 days, OR single insider buying > $100K.

Output:
```json
{
  "TICKER": {
    "filings": [
      { "insider": "John Doe", "title": "CFO", "date": "2026-05-10", "shares": 5000, "price": 12.50, "value": 62500 }
    ],
    "totalValue30d": 250000,
    "buyerCount30d": 3,
    "clusterBuy": true
  }
}
```

Save to `data/insider_data.json`, refresh once daily via new GitHub Action `insider-scan.yml`.

### 2.2 News sentiment per ticker

**New file:** `scripts/news_scan.js`

Yahoo Finance news API works without auth:
```
https://query2.finance.yahoo.com/v1/finance/search?q=<TICKER>&newsCount=10
```

For each leader/discovery, fetch recent news. Pass headlines through Claude Haiku for sentiment scoring:
```javascript
prompt = `Score these headlines as one of: bullish, bearish, mixed, neutral.
Stock: ${symbol}
Headlines (last 7 days):
1. ${h1}
2. ${h2}
...

Return JSON: {"sentiment": "bullish|bearish|mixed|neutral", "summary": "<25 words>", "keyHeadline": "..."}`;
```

Output to `data/news_sentiment.json`. Triggered after main scan in same workflow.

### 2.3 Analyst ratings tracker

**Already accessible via Yahoo `quoteSummary`** — just expose recent changes in the scan record (see 1.4). Display rule:
- ≥ 2 upgrades in past 30 days = bullish catalyst
- ≥ 2 downgrades in past 30 days = bearish flag

### 2.4 **THE Triple-Resonance Radar** (homepage feature)

**File:** `index.html`

New dashboard card prominently placed (top of homepage, above existing RS Leader card):

```
🎯 三重共振雷達 — 財報 + VCP + 內部人買入

下列股票同時符合三大領先指標：
✓ 未來 14 天內財報
✓ VCP score ≥ 2  
✓ 過去 30 天內部人 cluster buying OR 殖利率分析師升評
✓ RS Rating ≥ 80

[STOCK]  財報倒數 7 天 · VCP 4/4 · 內部人買入 $850K · ★★★★★
[STOCK]  財報倒數 12 天 · VCP 3/4 · 2 位分析師升評 · ★★★★

這些股票具備"事前可見的爆發條件組合"。歷史回測：勝率 67%、平均報酬 +14.2%、平均持有 18 天。
```

The triple-resonance candidates are computed at scan time and saved to `data/triple_resonance.json`:
```json
{
  "generatedAt": <timestamp>,
  "candidates": [
    {
      "symbol": "...",
      "rank": 1,
      "daysToEarnings": 7,
      "vcpScore": 4,
      "insiderValue30d": 850000,
      "rsRating": 87,
      "compositeStars": 5,
      "reasons": ["VCP 4/4 tight base", "Cluster buying ($850K, 3 insiders)", "Earnings in 7 days"]
    }
  ]
}
```

**Acceptance:** When this radar shows candidates, clicking them goes straight to stock page with all data pre-populated. If no candidates that day, show "no setups matching all criteria — relax filters?" with adjustable thresholds.

### 2.5 Earnings season power play

**File:** `index.html`, new section

Show a calendar view: "未來 14 天有財報的 RS Leader" — filter the scan results to just stocks with earnings approaching. Sort by combination of (VCP score) + (days to earnings ascending) + (RS rank).

For each: show last 4 quarters' earnings surprise history (from 1.4 data) — stocks that consistently beat tend to keep beating.

---

## PHASE 3 — Backtest Infrastructure (credibility)

### 3.1 Signal performance tracker

**New file:** `scripts/backtest.js`

This is non-trivial. Approach:

**Step 1:** Maintain `data/signal_history.json`:
```json
{
  "signals": [
    {
      "id": "rs_leader_2026-05-14_NVDA",
      "type": "rs_leader",
      "symbol": "NVDA",
      "triggeredAt": "2026-05-14T13:25:00Z",
      "entryPrice": 142.50,
      "exitPrice": null,
      "exitDate": null,
      "stopLoss": 131.10,
      "target": 165.00,
      "status": "open" // open | hit_target | hit_stop | timed_out
    }
  ]
}
```

**Step 2:** Every scan run, the script also:
- Adds new entries for any new RS Leader / Discovery / VCP / Triple-Resonance signals
- For all open entries, checks if current price hit target or stop
- Times out entries older than 60 days as `timed_out` with current price as exit

**Step 3:** Compute rolling stats per signal type:
```json
{
  "rs_leader": {
    "trailing_252d": {
      "total": 218,
      "winners": 132,
      "losers": 64,
      "open": 22,
      "winRate": 0.673,
      "avgWin": 12.4,
      "avgLoss": -7.8,
      "avgReturn": 5.6,
      "sharpe": 1.32
    }
  }
}
```

**Step 4:** Frontend displays per-signal stats in the scanner UI:
> "RS Leader 訊號 · 過去 252 天勝率 67%、平均報酬 +5.6%、Sharpe 1.32"

If a signal has < 20 historical entries, show "資料不足（N=15）" instead.

### 3.2 Strategy comparison page

**New tab in `index.html`:** `策略表現`

Bar chart showing each strategy's win rate, avg return, Sharpe. User can see: "Schwartz Breakout has 71% win rate but Discovery has 45% — I'll trust the former more."

**File modifications:**
- Add `tab-strategy-perf` in HTML
- Add `renderStrategyPerformance()` function  
- Fetches `data/signal_history.json` from GitHub raw

---

## PHASE 4 — Pattern Quality Upgrade

### 4.1 Minervini base-count VCP

**File:** `scripts/scan.js`, replace `calcVCP`

Real VCP is about **base structure**, not just volatility:
```javascript
function calcVCPv2(closes, highs, lows, volumes) {
  // 1. Identify "bases" — consolidation periods of 5+ days where
  //    high-low range is < 15% AND price stays above its starting low
  // 2. Identify "pivots" — the high of each base
  // 3. Count consecutive bases since last 20%+ pullback
  // 4. Score:
  //    - Base 1 (first base after uptrend) = highest quality, score 4
  //    - Base 2 = good, score 3
  //    - Base 3 = okay but riskier, score 2
  //    - Base 4+ = late-stage, score 1 (RED FLAG)
  // 5. Bonus +1 if current pullback < prior pullback (proper contraction)
  // 6. Bonus +1 if volume in current base < volume in prior base
  
  // ... detailed implementation
}
```

**Acceptance:** VCP detection accurately distinguishes "Base 1" (high probability) from "Base 4" (low probability) setups. Display in UI: "VCP 4/4 (Base 2)".

### 4.2 Pivot point detection

**File:** `index.html`, `calcTA` function

For each VCP base, identify the **pivot** (highest high in the consolidation). Display: "突破點 $X.XX — 突破需放量 1.5x 以上". This is the **actual entry trigger price** that Minervini uses.

### 4.3 GMMA (Guppy Multiple Moving Average)

**File:** `index.html`, `calcTA`

Compute 6 short EMAs (3, 5, 8, 10, 12, 15) and 6 long EMAs (30, 35, 40, 45, 50, 60).
- All short > all long, fanning out = strong uptrend
- All compressed = consolidation
- All short < all long = strong downtrend

Add to `ta.gmma`: `{ trend: 'strong-up' | 'consolidation' | 'strong-down', strength: 0-10 }`.

### 4.4 Volume Profile (Point of Control)

**File:** `index.html`, `calcTA`

Compute volume profile over last 60 days:
- Price buckets (50 levels from low to high)
- Total volume traded in each bucket
- POC (Point of Control) = bucket with max volume
- VAH/VAL = 70% volume containment zone

Display: "POC $X (主要成交區) · VAH $Y · VAL $Z". This shows where institutional support lies.

---

## PHASE 5 — Portfolio Intelligence

### 5.1 Auto-Kelly from journal history

**File:** `index.html`, `calcKelly`

Currently: manual input.

Change: scan user's journal entries (`getJ()`), compute their actual win rate, avg win, avg loss from closed positions. Pre-fill Kelly inputs with these values. Display: "根據你過去 47 筆交易：勝率 52%、盈虧比 1.8 — Half Kelly 建議 11.4%/筆".

### 5.2 Holdings correlation matrix

**File:** `index.html`, new function `renderCorrelationMatrix`

For currently open positions, fetch 60-day correlation matrix. Highlight pairs with correlation > 0.7 — "warning: NVDA and AMD are 0.82 correlated — high concentration risk".

Compute correlations in JS from price arrays already cached.

### 5.3 Sector concentration alert

**File:** `index.html`, dashboard

Group open positions by sector (using new sector mapping from 1.2). Show pie chart. Alert if any single sector > 40% of portfolio value.

### 5.4 Portfolio drawdown tracker

**File:** `index.html`, new section

For closed positions in journal:
- Equity curve (cumulative P/L over time)
- Max drawdown (worst peak-to-trough)
- Current drawdown
- Recovery factor (total profit / max drawdown)

### 5.5 Relative weakness "what to sell" alerts

**File:** `index.html`, dashboard

For each open position, compute its current RS rank vs when entered. If RS dropped > 20 positions OR stock no longer in top 100 RS, flag: "TICKER: RS 從 #15 跌到 #62 — 考慮減碼".

---

## PHASE 6 — AI Enhancement (real predictive layer)

### 6.1 Daily market narrative

**New file:** `scripts/market_narrative.js`

After main scan, send Claude a digest:
```
INPUT:
- Today's top 5 gainers + their sector
- Today's top 5 losers + their sector  
- Sector ETF performance (XLK, XLE, XLF, etc.)
- VIX level + change
- 10y yield change
- Top 5 news headlines (from news API)
- Breadth (advance/decline ratio)

TASK: In 100 words, summarize today's market narrative.
What's the story? What's flowing in/out?
Is risk-on or risk-off? 
Bottom line for tomorrow.
```

Save to `data/market_narrative.json`. Display prominently on homepage as "🌍 今日市場敘事".

### 6.2 AI portfolio review

**File:** `index.html`, new dashboard card

Button: "🤖 讓 Claude 檢視我的持倉"

Sends to Claude API (frontend call to a backend proxy, or direct from GitHub Actions on schedule):
```
My open positions:
- NVDA: $142, entered $130, +9%, sector Tech, RS rank 5
- ONDS: $11, entered $9.50, +16%, sector Tech, RS rank N/A
- ... 

Current market regime: SPY +12% vs 200MA, VIX 14, growth dominant.

Task: 
1. Concentration risks
2. Stocks showing weakness (consider trimming)  
3. Hedging suggestion if any
4. Overall portfolio health rating 1-10
```

### 6.3 Per-stock catalyst summarizer

**File:** `scripts/ai_analysis.js`, enhance existing script

Currently: analyzes TA data only.

Add: news headlines + recent insider activity + recent analyst changes to prompt. Claude can then make actual catalyst-aware judgments.

Update prompt structure to include:
```
RECENT NEWS (last 7d):
- "Company X announces major partnership..."
- "Analyst upgrades to Buy, $45 target..."

INSIDER ACTIVITY (last 30d):
- CFO bought 5000 shares at $12.50
- Director sold 1000 shares at $13.00

ANALYST CHANGES:
- 2 upgrades, 0 downgrades in past 30 days
```

This is where Claude actually adds value — synthesizing multi-source data the user can't easily compile.

---

## PHASE 7 — UX / Information Hierarchy

### 7.1 Information priority redesign

**File:** `index.html`

Current order on stock page: chart → tech score → tech indicators table → entry boxes → fundamentals → AI analysis (bottom).

**New order:**
1. **Big move warning** (if any) — full-width banner
2. **Catalyst alerts** (earnings imminent, insider buying, analyst change) — colored cards
3. **AI forward analysis** — moved to top
4. **Entry/stop/target boxes** with clear setup type label
5. Chart
6. Tech score + indicators (collapsible "詳細技術指標")
7. Fundamentals (collapsible)
8. K-line patterns

### 7.2 Conditional alerts system

**File:** `index.html`, new section "我的警報"

Allow user to set conditions:
- "When AAPL crosses $180" → notify
- "When NVDA RSI > 70" → notify  
- "When portfolio drawdown > 5%" → notify
- "When VIX > 25" → notify

Backend: alerts checked every 5 minutes by service worker (already partially implemented for push notifications). Store conditions in localStorage.

UI: simple form to add/remove alerts. Show active count.

### 7.3 Mobile responsive audit

**File:** `index.html`

Action items:
- Add `@media (max-width: 768px)` for all card grids → collapse to 1 column
- Tables → horizontal scroll OR collapse to card view on mobile
- Reduce font sizes appropriately
- Remove hover-only interactions (touch users can't hover)
- Test all pages on iPhone 12 viewport (390px)

### 7.4 Educational → action linkage

**File:** `index.html`

After Schwartz Breakout content, add: "📍 今天有 X 支股票符合 Schwartz 設定 →" linking to filtered scanner view.

After Kelly content, add: "📊 根據你的歷史 → 建議倉位 X%".

After ATR content, add: "🎯 你的目前持倉 ATR 健康度評估 →".

---

## PHASE 8 — Optional Premium Upgrades

### 8.1 Real-time data feed evaluation

Consider migrating from Yahoo Finance to:
- **Polygon.io** ($29/mo): real-time, options, news, fundamentals all in one
- **Alpaca** (free with brokerage): real-time, limited fundamentals
- **IEX Cloud** ($9-$39/mo): real-time, news, basic fundamentals

Recommendation: stay with Yahoo for now, add Polygon for real-time quotes on currently-watched stocks only.

### 8.2 Broker integration

Add Alpaca paper trading API integration:
- See real positions
- Auto-track entries/exits in journal
- Test signals with real execution

---

## Implementation Order (Phase 1 → 7 sequentially, parallelize where noted)

### Wave 1 (Foundation, must finish first — ~3-4 hours):
- 1.1 Universe expansion
- 1.2 Sector mapping fix  
- 1.3 Add opens to OHLC
- 1.4 Add earnings/short interest to scan

### Wave 2 (Parallelizable, ~4-5 hours):
- 2.1 Insider buying scan (new workflow)
- 2.2 News sentiment scan (new workflow)
- 2.3 Analyst ratings in scan output
- 2.4 Triple-resonance radar (after 2.1, 2.2)
- 2.5 Earnings power play view
- 3.1 Backtest infrastructure (independent)

### Wave 3 (Pattern quality, ~3-4 hours):
- 4.1 Minervini base-count VCP
- 4.2 Pivot point detection
- 4.3 GMMA
- 4.4 Volume Profile

### Wave 4 (UX + Portfolio, ~3-4 hours):
- 5.1 Auto-Kelly
- 5.2 Correlation matrix
- 5.3 Sector concentration
- 5.4 Drawdown tracker
- 5.5 Relative weakness alerts
- 7.1 Information priority redesign
- 7.3 Mobile audit
- 7.4 Educational linkage

### Wave 5 (AI synthesis, ~2-3 hours):
- 6.1 Market narrative
- 6.2 AI portfolio review
- 6.3 Catalyst-aware per-stock analysis

### Wave 6 (Backtest display, ~1-2 hours):
- 3.2 Strategy comparison page
- Final backtest stats display in scanner

### Wave 7 (Alerts, ~1-2 hours):
- 7.2 Conditional alerts

---

## Acceptance Criteria (overall)

After full implementation:
1. **Triple-Resonance Radar** detects ONDS-type setups 7-14 days before earnings catalyst
2. Every signal in scanner shows its historical win rate + avg return
3. Universe size ≥ 1500 unique tickers (currently ~200)
4. Sector mapping covers ≥ 90% of leaders (currently ~24%)
5. Mobile experience is genuinely usable (no horizontal scroll on main views)
6. AI analysis includes news + insider + analyst data (not just TA)
7. Portfolio page shows correlation matrix + drawdown + sector breakdown
8. Educational content has actionable links to current matching setups

---

## Key Constraints / Risks

- **Yahoo API rate limits**: must add caching aggressively, use `data/quote_cache.json` with 24h TTL for fundamentals
- **SEC EDGAR rate limits**: 10 req/sec max, use User-Agent header per their guidelines
- **Claude API costs**: each scan generates ~15 stock analyses × 3/day = ~45 calls/day. With Haiku at ~$0.001/call = $1.35/month. Triple-resonance + market narrative add maybe $1/month. Total < $5/month.
- **GitHub Actions minutes**: free tier is 2000 min/mo. Current usage ~30 min/day = 900/mo. Adding insider + news + AI workflows ~10 min each daily = 60 min/day = 1800/mo total. Within budget.
- **Static JSON file sizes**: us_scan.json is currently ~30KB. With expanded universe + extra fields → maybe 200KB. Still acceptable for GitHub raw serving.

---

## Sonnet: Start Here

When you implement this:

1. **Read this entire plan first**
2. **Start with Wave 1 (Phase 1)** — these block everything else
3. **For each task:**
   - Implement the code changes
   - Run syntax check
   - Test the data output if applicable (`node scripts/scan.js us`)
   - Commit with descriptive message
   - Push (remember `git pull --rebase && git push` because Actions writes back)
4. **Update this plan as you go** — strike through completed items
5. **Stop and ask the user when:**
   - A design decision requires their input (e.g., "should the alert sound be enabled by default?")
   - An API requires a new secret to be added (e.g., NewsAPI key)
   - You discover a structural blocker not anticipated here
6. **Always preserve existing functionality** — don't break the current scanner while adding features

Test each wave end-to-end before moving to the next. Don't try to do everything in one commit — small, focused commits make it easier to debug.

Good luck.
