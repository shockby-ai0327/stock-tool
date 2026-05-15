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
    'In 100-120 words (繁體中文), provide today\'s market narrative:',
    '1. What\'s the dominant theme/story today?',
    '2. Is money flowing into risk-on or risk-off?',
    '3. Which sectors are leading vs lagging? Why might that be?',
    '4. Bottom line for tomorrow — what should traders be watching?',
    '',
    'Return ONLY valid JSON, no markdown:',
    '{',
    '  "headline": "<one-line summary in 繁體中文, 15 words max>",',
    '  "narrative": "<100-120 word analysis in 繁體中文>",',
    '  "regime": "risk-on" | "risk-off" | "rotation" | "neutral",',
    '  "sectorRotation": {"into": ["XLK","XLF"], "outOf": ["XLE","XLP"]},',
    '  "tomorrowWatch": "<one-line actionable item in 繁體中文>"',
    '}',
  ];
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

main().catch(e => { console.error(e); process.exit(0); });
