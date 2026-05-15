/**
 * ai_analysis.js — Claude AI Forward Analysis for Top RS Leaders
 * Reads us_scan.json / tw_scan.json, calls Claude API for each of the top 15
 * leaders, outputs forward-looking qualitative analysis to
 * data/us_ai_analysis.json / data/tw_ai_analysis.json
 *
 * Requires: ANTHROPIC_API_KEY env var
 * Run: node scripts/ai_analysis.js [us|tw|all]
 */

import fetch from 'node-fetch';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('❌  ANTHROPIC_API_KEY is not set. Skipping AI analysis.');
  process.exit(0); // exit 0 so workflow doesn't fail
}

const DELAY = ms => new Promise(r => setTimeout(r, ms));

// ── Call Claude API directly via fetch ─────────────────────────────────────
async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.content[0].text.trim();
}

// ── Build analysis prompt for a single stock ───────────────────────────────
// Now catalyst-aware: includes earnings, insider, news, analyst data when available
function buildPrompt(stock, benchmark, rank, insiderInfo, newsInfo) {
  const pctFromHigh52 = ((stock.price / stock.high52w - 1) * 100).toFixed(1);
  const pctFromHigh3m = ((stock.price / stock.high3m - 1) * 100).toFixed(1);

  const vcpNote = stock.vcpScore >= 2
    ? `VCP (Volatility Contraction): detected — score ${stock.vcpScore}/4, ${stock.vcpDepth}% base depth (tight consolidation, breakout-ready)`
    : stock.vcpScore === 1
    ? `VCP: mild contraction detected (score 1/4, ${stock.vcpDepth}% depth)`
    : 'VCP: not detected (no volatility contraction pattern)';

  const accelNote = stock.accel != null
    ? `Momentum Acceleration: ${stock.accel.toFixed(2)}x (${stock.accel >= 1.3 ? 'strongly accelerating' : stock.accel >= 1.0 ? 'accelerating' : 'decelerating'})`
    : 'Momentum Acceleration: N/A';

  const sectorNote = stock.sectorRS != null
    ? `Sector (${stock.sectorEtf}): RS vs index = ${stock.sectorRS > 0 ? '+' : ''}${stock.sectorRS}% (${stock.sectorRS > 5 ? 'sector leading' : stock.sectorRS < -5 ? 'sector lagging' : 'sector neutral'})`
    : `Sector: ${stock.sectorEtf || 'unmapped'}`;

  // Catalyst-aware sections (only added if data exists)
  const catalystSections = [];

  if (stock.daysToEarnings != null && stock.daysToEarnings >= 0) {
    let earnNote = `EARNINGS: Next earnings in ${stock.daysToEarnings} days`;
    if (stock.surpriseHistory && stock.surpriseHistory.length) {
      const surprises = stock.surpriseHistory.map(s => s.surprisePct).filter(s => s != null);
      if (surprises.length) {
        const beats = surprises.filter(s => s > 0).length;
        earnNote += `\nLast ${surprises.length} quarters: ${beats}/${surprises.length} beats. Surprises: ${surprises.map(s => (s > 0 ? '+' : '') + s + '%').join(', ')}`;
      }
    }
    catalystSections.push(earnNote);
  }

  if (insiderInfo && insiderInfo.totalValue30d > 0) {
    catalystSections.push(
      `INSIDER ACTIVITY (30d): ${insiderInfo.buyerCount30d} insider${insiderInfo.buyerCount30d > 1 ? 's' : ''} bought, total $${(insiderInfo.totalValue30d / 1000).toFixed(0)}K. Cluster buying: ${insiderInfo.clusterBuy ? 'YES (notable signal)' : 'no'}`
    );
  }

  const upgradesCount = (stock.recentUpgrades || []).length;
  const downgradesCount = (stock.recentDowngrades || []).length;
  if (upgradesCount + downgradesCount > 0) {
    catalystSections.push(
      `ANALYST CHANGES (30d): ${upgradesCount} upgrades, ${downgradesCount} downgrades` +
      (upgradesCount >= 2 ? ' (multiple upgrades = bullish catalyst)' : '') +
      (downgradesCount >= 2 ? ' (multiple downgrades = WARNING)' : '')
    );
  }

  if (newsInfo && newsInfo.sentiment) {
    catalystSections.push(
      `NEWS SENTIMENT (7d): ${newsInfo.sentiment}${newsInfo.summary ? ' — ' + newsInfo.summary : ''}${newsInfo.keyHeadline ? '\nKey headline: "' + newsInfo.keyHeadline + '"' : ''}`
    );
  }

  if (stock.shortPctOfFloat != null && stock.shortPctOfFloat > 0.10) {
    catalystSections.push(
      `SHORT INTEREST: ${(stock.shortPctOfFloat * 100).toFixed(1)}% of float, ${stock.shortRatio != null ? stock.shortRatio.toFixed(1) + ' days to cover' : 'days-to-cover N/A'}${stock.shortPctOfFloat > 0.20 ? ' (HIGH — squeeze potential if momentum continues)' : ''}`
    );
  }

  const catalystBlock = catalystSections.length
    ? '\n--- CATALYST DATA ---\n' + catalystSections.join('\n') + '\n'
    : '';

  return `You are a professional momentum equity analyst using IBD/Minervini methodology. Analyze the following stock for the NEXT 30–60 days forward outlook.

STOCK: ${stock.symbol} (${stock.name}) — RS Rank #${rank}
Price: $${stock.price} | RS Rating: ${stock.rsRating || 'N/A'}/99 | Composite Score: ${stock.compositeScore || 'N/A'}
12-1 Month RS vs ${benchmark.symbol}: ${stock.ret12_1 > 0 ? '+' : ''}${stock.ret12_1}% vs ${benchmark.ret12_1 > 0 ? '+' : ''}${benchmark.ret12_1}%
1-Month Return: ${stock.ret1m > 0 ? '+' : ''}${stock.ret1m}%
3-Month Return: ${stock.ret3m > 0 ? '+' : ''}${stock.ret3m}%
${accelNote}
Volume Expansion: ${stock.volExpand != null ? stock.volExpand.toFixed(2) + 'x' : 'N/A'} vs 20-day avg
${sectorNote}
${vcpNote}
Position vs 52-week high: ${pctFromHigh52}% | vs 3-month high: ${pctFromHigh3m}%
${catalystBlock}

TASK: Provide a concise forward-looking analysis (80–120 words total). Be direct and trader-focused — no generic disclaimers. ${catalystBlock ? 'USE the catalyst data above — weave specific facts into your analysis.' : ''}

Cover:
1. Whether this momentum is likely to CONTINUE or STALL in 30–60 days, and why
2. The single most important catalyst or condition to WATCH (specific and actionable — use real data above)
3. The single biggest RISK that could derail this setup
${stock.daysToEarnings != null && stock.daysToEarnings <= 14 ? '4. CRITICAL: Earnings in ' + stock.daysToEarnings + ' days. Comment on pre-earnings setup quality and beat/miss probability based on surprise history.' : ''}
${insiderInfo && insiderInfo.clusterBuy ? '5. Insider cluster buying detected — weight this as a strong bullish signal.' : ''}
${downgradesCount >= 2 ? '6. Multiple analyst downgrades — flag explicitly as bearish.' : ''}

Return ONLY valid JSON, no markdown, no extra text:
{"outlook": "...", "catalyst": "...", "risk": "...", "bias": "bullish|neutral|bearish", "stars": 1-5, "catalystAware": ${catalystBlock ? 'true' : 'false'}}

Stars: 5=exceptional setup with confirmed catalysts, 4=strong, 3=decent momentum, 2=marginal, 1=weak/extended/negative catalysts`;
}

// ── Analyze a single market's leaders ─────────────────────────────────────
async function analyzeMarket(market) {
  const scanFile = join(DATA_DIR, `${market}_scan.json`);
  const outFile  = join(DATA_DIR, `${market}_ai_analysis.json`);

  let scan;
  try {
    scan = JSON.parse(readFileSync(scanFile, 'utf-8'));
  } catch (e) {
    console.error(`  Cannot read ${market}_scan.json: ${e.message}`);
    return;
  }

  const leaders   = (scan.leaders   || []).slice(0, 15);
  const discoveries = (scan.discoveries || []).slice(0, 5);
  const allStocks = [...leaders, ...discoveries.filter(d => !leaders.find(l => l.symbol === d.symbol))];
  const benchmark = scan.benchmark || { symbol: 'SPY', ret12_1: 0 };

  // Wave 6.3 — load catalyst data if available (insider buying + news sentiment)
  let insiderData = {}, newsData = {};
  try { insiderData = JSON.parse(readFileSync(join(DATA_DIR, 'insider_data.json'), 'utf-8')) || {}; } catch(e) {}
  try {
    const newsRaw = JSON.parse(readFileSync(join(DATA_DIR, `${market}_news_sentiment.json`), 'utf-8'));
    if (newsRaw && newsRaw.bySymbol) newsData = newsRaw.bySymbol;
    else if (newsRaw && Array.isArray(newsRaw.items)) {
      newsRaw.items.forEach(n => { newsData[n.symbol] = n; });
    } else if (newsRaw && typeof newsRaw === 'object') newsData = newsRaw;
  } catch(e) {}
  const insiderCount = Object.keys(insiderData).length;
  const newsCount = Object.keys(newsData).length;
  console.log(`\n[${market.toUpperCase()}] Analyzing ${allStocks.length} stocks (insider data: ${insiderCount} tickers, news: ${newsCount} tickers)...`);

  const analyses = [];
  for (let i = 0; i < allStocks.length; i++) {
    const stock = allStocks[i];
    const rank = i + 1;
    try {
      process.stdout.write(`  [${rank}/${allStocks.length}] ${stock.symbol}... `);
      const insiderInfo = insiderData[stock.symbol] || null;
      const newsInfo = newsData[stock.symbol] || null;
      const prompt = buildPrompt(stock, benchmark, rank, insiderInfo, newsInfo);
      const raw = await callClaude(prompt);

      // Parse JSON response — Claude may occasionally wrap in markdown
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in response');
      const parsed = JSON.parse(jsonMatch[0]);

      analyses.push({
        symbol:      stock.symbol,
        name:        stock.name,
        rank,
        isDiscovery: !leaders.find(l => l.symbol === stock.symbol),
        bias:          parsed.bias   || 'neutral',
        stars:         Math.max(1, Math.min(5, parseInt(parsed.stars) || 3)),
        outlook:       parsed.outlook || '',
        catalyst:      parsed.catalyst || '',
        risk:          parsed.risk || '',
        catalystAware: parsed.catalystAware === true,
        analyzedAt:    Date.now(),
      });
      console.log(`${parsed.bias} ${'★'.repeat(parsed.stars || 3)}`);
      await DELAY(600); // rate-limit buffer
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
    }
  }

  const output = {
    market:      market.toUpperCase(),
    generatedAt: Date.now(),
    scannedAt:   scan.scannedAt,
    benchmark,
    analyses,
  };

  writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`  ✅ Saved ${analyses.length} analyses → ${market}_ai_analysis.json`);
}

// ── Main ───────────────────────────────────────────────────────────────────
const arg = process.argv[2] || 'us';
const markets = arg === 'all' ? ['us', 'tw'] : [arg];

for (const m of markets) {
  await analyzeMarket(m);
}
console.log('\nDone.');
