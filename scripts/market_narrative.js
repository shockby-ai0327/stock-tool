/**
 * market_narrative.js — Daily Market Narrative via Claude
 * Reads latest scan + fetches macro indicators + asks Claude for today's story
 * Output: data/market_narrative.json
 * Cost: ~$0.005 per run (Haiku, 1 call)
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
  console.error('ANTHROPIC_API_KEY not set; skipping market narrative.');
  process.exit(0);
}

const YF_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const DELAY = ms => new Promise(r => setTimeout(r, ms));

async function yfFetch(url, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': YF_UA }, signal: AbortSignal.timeout(10000) });
      if (r.ok) return await r.json();
    } catch (e) {}
    if (i < retries - 1) await DELAY(800);
  }
  return null;
}

async function getDayChange(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`;
  const d = await yfFetch(url);
  const closes = d?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v => v != null);
  if (!closes || closes.length < 2) return null;
  const cur = closes[closes.length - 1], prev = closes[closes.length - 2];
  return { last: +cur.toFixed(2), changePct: +((cur - prev) / prev * 100).toFixed(2) };
}

async function fetchScreenerTop5(scrId) {
  const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${scrId}&start=0&count=5&formatted=false`;
  const d = await yfFetch(url);
  const quotes = d?.finance?.result?.[0]?.quotes || [];
  return quotes.slice(0, 5).map(q => ({
    symbol: q.symbol,
    name: (q.shortName || q.longName || q.symbol).slice(0, 30),
    changePct: q.regularMarketChangePercent != null ? +q.regularMarketChangePercent.toFixed(2) : null,
  }));
}

// 2026-05-21 Level 2: token usage 追蹤
const _runUsage = { input: 0, output: 0, calls: 0 };
function _writeUsage(scriptName) {
  try {
    const file = join(DATA_DIR, 'api_usage.json');
    let usage = { months: {}, lastUpdated: 0 };
    try { usage = JSON.parse(readFileSync(file, 'utf8')); } catch(e) {}
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
    console.log(`📊 token usage: ${_runUsage.input} in / ${_runUsage.output} out / ${_runUsage.calls} calls`);
  } catch(e) { console.warn('  writeUsage fail:', e.message); }
}

async function callClaude(prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  if (data.usage) {
    _runUsage.input  += data.usage.input_tokens  || 0;
    _runUsage.output += data.usage.output_tokens || 0;
    _runUsage.calls++;
  }
  return data.content[0].text.trim();
}

async function main() {
  const market = process.argv[2] || 'us';
  const scanFile = join(DATA_DIR, `${market}_scan.json`);
  let scan;
  try {
    scan = JSON.parse(readFileSync(scanFile, 'utf-8'));
  } catch (e) {
    console.error(`Cannot read ${market}_scan.json:`, e.message);
    process.exit(0);
  }

  console.log('Fetching macro indicators...');
  const SECTOR_ETFS = ['XLK', 'IGV', 'SMH', 'XLF', 'XLE', 'XLY', 'XLV', 'XLI', 'XLB', 'XLP', 'XLU', 'XLC', 'XLRE', 'IBB', 'GDX', 'XAR'];

  const [spy, vix, tnx, dxy, sectorData, gainers, losers] = await Promise.all([
    getDayChange('SPY'),
    getDayChange('^VIX'),
    getDayChange('^TNX'),
    getDayChange('DX-Y.NYB'),
    Promise.all(SECTOR_ETFS.map(async s => ({ etf: s, ...(await getDayChange(s)) }))),
    fetchScreenerTop5('day_gainers'),
    fetchScreenerTop5('day_losers'),
  ]);

  const validSectors = sectorData.filter(s => s.changePct != null);
  validSectors.sort((a, b) => b.changePct - a.changePct);
  const sectorTop3 = validSectors.slice(0, 3);
  const sectorBot3 = validSectors.slice(-3).reverse();

  const top5Leaders = (scan.leaders || []).slice(0, 5).map(l => ({
    symbol: l.symbol, ret1m: l.ret1m, rs: l.rsRating, accel: l.accel,
  }));
  const tripleRes = (scan.tripleResonance || []).slice(0, 5).map(t => ({
    symbol: t.symbol, stars: t.stars,
  }));

  const promptParts = [
    'You are a professional market commentator. Today\'s data:',
    '',
    `SPY: ${spy ? spy.changePct + '%' : 'N/A'} | VIX: ${vix ? vix.last + ' (' + vix.changePct + '%)' : 'N/A'} | 10Y Yield: ${tnx ? tnx.last + ' (' + tnx.changePct + '%)' : 'N/A'} | DXY: ${dxy ? dxy.changePct + '%' : 'N/A'}`,
    '',
    'Top sector ETFs today (best → worst):',
    ...sectorTop3.map(s => `+ ${s.etf}: ${s.changePct}%`),
    ...sectorBot3.map(s => `- ${s.etf}: ${s.changePct}%`),
    '',
    `Top 5 gainers: ${gainers.map(g => g.symbol + ' (' + g.changePct + '%)').join(', ')}`,
    `Top 5 losers: ${losers.map(l => l.symbol + ' (' + l.changePct + '%)').join(', ')}`,
    '',
    'Top 5 RS Leaders (momentum):',
    ...top5Leaders.map(l => `- ${l.symbol}: 1mo ${l.ret1m}%, RS ${l.rs}, accel ${l.accel}x`),
    '',
    tripleRes.length ? 'Triple-Resonance candidates (earnings + VCP + insider): ' + tripleRes.map(t => t.symbol + ' (' + t.stars + '★)').join(', ') : 'No Triple-Resonance candidates today.',
    '',
  ];

  // 2026-05-23: 時間感知 prompt — pre-market / midday / near-close 不同問法
  const etNow = new Date(Date.now() - 5 * 3600000);  // 粗略換算 ET（不處理 DST，誤差 1 小時可接受）
  const etHour = etNow.getUTCHours();
  let sessionLabel, questionBlock, watchLabel;
  if (etHour < 9 || (etHour === 9 && etNow.getUTCMinutes() < 30)) {
    sessionLabel = 'PRE-MARKET (before US open)';
    questionBlock = [
      'In 100-120 words (繁體中文), provide PRE-MARKET briefing:',
      '1. What overnight news / futures move sets up today\'s session?',
      '2. Pre-market gainers/losers — any major gap movers worth attention?',
      '3. Key macro events / earnings releases scheduled today?',
      '4. Risk-on or risk-off setup heading into the open?',
    ];
    watchLabel = '今日開盤關注';
  } else if (etHour < 13) {
    sessionLabel = 'MORNING SESSION (post-open, first 3.5 hours)';
    questionBlock = [
      'In 100-120 words (繁體中文), provide MIDDAY UPDATE:',
      '1. What has actually played out vs pre-market expectations?',
      '2. Surprise winners/losers in the first half — why?',
      '3. Sector rotation visible so far (intraday)?',
      '4. What to watch for the rest of session?',
    ];
    watchLabel = '下午盤關注';
  } else if (etHour < 16) {
    sessionLabel = 'AFTERNOON SESSION (last 2 hours before close)';
    questionBlock = [
      'In 100-120 words (繁體中文), provide AFTERNOON CHECK-IN:',
      '1. What\'s today\'s dominant theme/story?',
      '2. Is money flowing into risk-on or risk-off?',
      '3. Which sectors are leading vs lagging? Why?',
      '4. Setup for close — sell-off into close or strong finish?',
    ];
    watchLabel = '收盤前關注';
  } else {
    sessionLabel = 'POST-CLOSE (market closed)';
    questionBlock = [
      'In 100-120 words (繁體中文), provide POST-CLOSE WRAP-UP:',
      '1. What was today\'s dominant theme/story?',
      '2. Was money risk-on or risk-off today?',
      '3. Which sectors led vs lagged? Why?',
      '4. Bottom line for tomorrow — what should traders watch?',
    ];
    watchLabel = '明日關注';
  }

  promptParts.push('CURRENT SESSION: ' + sessionLabel);
  promptParts.push('');
  promptParts.push(...questionBlock);
  promptParts.push('');
  promptParts.push('Return ONLY valid JSON, no markdown:');
  promptParts.push('{');
  promptParts.push('  "headline": "<one-line summary in 繁體中文, 15 words max>",');
  promptParts.push('  "narrative": "<100-120 word analysis in 繁體中文>",');
  promptParts.push('  "regime": "risk-on" | "risk-off" | "rotation" | "neutral",');
  promptParts.push('  "sectorRotation": {"into": ["XLK","XLF"], "outOf": ["XLE","XLP"]},');
  promptParts.push('  "session": "' + sessionLabel + '",');
  promptParts.push('  "watchLabel": "' + watchLabel + '",');
  promptParts.push('  "tomorrowWatch": "<one-line actionable item in 繁體中文>"');
  promptParts.push('}');
  const prompt = promptParts.join('\n');

  console.log('Calling Claude haiku...');
  try {
    const raw = await callClaude(prompt);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    const parsed = JSON.parse(jsonMatch[0]);

    const output = {
      generatedAt: Date.now(),
      market: market.toUpperCase(),
      scanAt: scan.scannedAt,
      session: sessionLabel,       // 2026-05-23: session 識別供前端顯示
      sessionShort: sessionLabel.split(' ')[0].toLowerCase(),  // pre-market / morning / afternoon / post-close
      watchLabel,                  // 適合該 session 的「關注」標題
      macros: { spy, vix, tnx, dxy },
      sectorLeaders: sectorTop3,
      sectorLaggards: sectorBot3,
      gainers, losers,
      narrative: parsed.narrative,
      headline: parsed.headline,
      regime: parsed.regime || 'neutral',
      sectorRotation: parsed.sectorRotation || { into: [], outOf: [] },
      tomorrowWatch: parsed.tomorrowWatch,
    };

    const outFile = join(DATA_DIR, `${market}_market_narrative.json`);
    writeFileSync(outFile, JSON.stringify(output, null, 2));
    console.log(`Saved → ${market}_market_narrative.json`);
    console.log(`Headline: ${parsed.headline}`);
    console.log(`Regime: ${parsed.regime}`);
  } catch (e) {
    console.error('Narrative generation failed:', e.message);
  }
}

main().then(() => _writeUsage('market_narrative')).catch(e => { console.error(e); _writeUsage('market_narrative'); process.exit(0); });
