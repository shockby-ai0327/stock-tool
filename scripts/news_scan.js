/**
 * news_scan.js — Per-ticker news sentiment via Yahoo Finance + Claude Haiku
 *
 * Reads us_scan.json, picks the top 20 stocks by compositeScore (leaders+
 * discoveries combined), fetches recent headlines from Yahoo Finance search,
 * sends them to Claude Haiku for sentiment classification.
 *
 * Output: data/news_sentiment.json
 *   { generatedAt, bySymbol: { TICKER: { sentiment, summary, keyHeadline, headlineCount } } }
 *
 * Requires: ANTHROPIC_API_KEY env var. Cost guard: only top 20 stocks analyzed
 * (~$0.02/run × 1/day = trivial monthly cost).
 */

import fetch from 'node-fetch';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

const DELAY = ms => new Promise(r => setTimeout(r, ms));

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY not set — skipping news sentiment scan.');
  process.exit(0);
}

const YF_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── JSON helpers ──────────────────────────────────────────────────────────
function loadJSON(filename, fallback) {
  const path = join(DATA_DIR, filename);
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { return fallback; }
}
function saveJSON(filename, data) {
  writeFileSync(join(DATA_DIR, filename), JSON.stringify(data, null, 2));
}

// ── Yahoo news fetch (no auth) ────────────────────────────────────────────
async function fetchYahooNews(symbol, count = 10) {
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=${count}&quotesCount=0`;
  const res = await fetch(url, {
    headers: { 'User-Agent': YF_UA, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const news = data?.news || [];
  // Filter to last 7 days
  const cutoffSec = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
  return news
    .filter(n => (n.providerPublishTime || 0) >= cutoffSec && n.title)
    .map(n => ({
      title:      n.title,
      publisher:  n.publisher || '',
      publishAt:  n.providerPublishTime || 0,
      link:       n.link || '',
    }));
}

// ── Claude Haiku sentiment scoring ────────────────────────────────────────
async function scoreSentiment(symbol, headlines) {
  const numbered = headlines
    .slice(0, 7)
    .map((h, i) => `${i + 1}. ${h.title}`)
    .join('\n');

  const prompt = `Score these recent headlines for ${symbol} as one of: bullish, bearish, mixed, neutral.
Also write a 20-word summary and identify the most important headline.

Headlines:
${numbered}

Return ONLY valid JSON, no markdown:
{"sentiment": "bullish|bearish|mixed|neutral", "summary": "...", "keyHeadline": "...", "headlineCount": ${headlines.length}}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 350,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  const raw = data.content?.[0]?.text?.trim() || '';
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON in response');
  const parsed = JSON.parse(m[0]);

  // Normalize sentiment value
  const validSentiments = new Set(['bullish', 'bearish', 'mixed', 'neutral']);
  if (!validSentiments.has(parsed.sentiment)) parsed.sentiment = 'neutral';
  return parsed;
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const market = (process.argv[2] || 'us').toLowerCase();
  console.log('\n=== News Sentiment Scan (Yahoo + Claude Haiku) — ' + market.toUpperCase() + ' ===');
  console.log(`Start: ${new Date().toISOString()}`);

  const scanFile = `${market}_scan.json`;
  const scan = loadJSON(scanFile, null);
  if (!scan) { console.error('No ' + scanFile + ' found — run scan.js first'); return; }

  // Top 20 by composite score across leaders+discoveries
  const merged = [
    ...(scan.leaders     || []),
    ...(scan.discoveries || []),
  ];
  const seen = new Set();
  const ranked = [];
  for (const s of merged.sort((a, b) => (b.compositeScore || 0) - (a.compositeScore || 0))) {
    if (seen.has(s.symbol)) continue;
    seen.add(s.symbol);
    ranked.push(s);
    if (ranked.length >= 20) break;
  }

  console.log(`  Targets: top ${ranked.length} stocks by composite score`);

  const bySymbol = {};
  for (let i = 0; i < ranked.length; i++) {
    const s = ranked[i];
    try {
      process.stdout.write(`  [${i + 1}/${ranked.length}] ${s.symbol}... `);
      const headlines = await fetchYahooNews(s.symbol);
      if (!headlines.length) { console.log('no recent news'); continue; }

      const sentiment = await scoreSentiment(s.symbol, headlines);
      bySymbol[s.symbol] = {
        ...sentiment,
        headlineCount: headlines.length,
        analyzedAt:    Date.now(),
      };
      console.log(`${sentiment.sentiment} (${headlines.length} headlines)`);
      await DELAY(600); // rate-limit Claude API
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
    }
  }

  const output = {
    generatedAt: Date.now(),
    scannedAt:   new Date().toISOString(),
    targetCount: ranked.length,
    bySymbol,
  };
  saveJSON(`${market}_news_sentiment.json`, output);

  const bullish = Object.values(bySymbol).filter(b => b.sentiment === 'bullish').length;
  const bearish = Object.values(bySymbol).filter(b => b.sentiment === 'bearish').length;
  console.log(`\nSaved → news_sentiment.json (${Object.keys(bySymbol).length} symbols · ${bullish} bullish · ${bearish} bearish)`);
  console.log(`End: ${new Date().toISOString()}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
