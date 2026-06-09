#!/usr/bin/env node
/**
 * translate_summaries.js — translate fundamentals business summaries to 繁中.
 *
 * fetch_fundamentals.py writes an English `summary` (what the company does) for
 * each scanned symbol. This adds `summaryZh` so the 基本面快照 panel can read in
 * Traditional Chinese. Cost is kept ~0 by caching every translation by a hash of
 * the English text (data/summary_zh_cache.json) — only NEW or changed summaries
 * ever hit the API. Batched, Haiku. Skips gracefully with no API key (the panel
 * falls back to the English summary).
 *
 * Mirrors the existing AI pipeline (ai_diligence.js): raw fetch, claude-haiku-4-5.
 * Requires: ANTHROPIC_API_KEY env var (same secret the other AI steps use).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');
const FUND = path.join(DATA, 'fundamentals.json');
const CACHE = path.join(DATA, 'summary_zh_cache.json');
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5';
const BATCH = 20;

const sha1 = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const load = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };

async function translateBatch(items) {
  const list = items.map(it => `[${it.symbol}] ${it.summary}`).join('\n');
  const prompt =
    '把下面每一段美股公司的英文業務描述,翻成「台灣用語的繁體中文」,每段濃縮成一句話(≤40字),' +
    '講清楚「這公司到底在做什麼」。只回傳一個 JSON 物件,key 是中括號裡的股票代號,value 是中文翻譯,' +
    '不要任何多餘文字或 markdown。\n\n' + list;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error('API ' + res.status + ' ' + (await res.text()).slice(0, 120));
  const data = await res.json();
  const text = (data.content || []).map(c => c.text || '').join('');
  const u = data.usage || {};
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in response');
  return { map: JSON.parse(m[0]), inTok: u.input_tokens || 0, outTok: u.output_tokens || 0 };
}

async function main() {
  console.log('=== Translate fundamentals summaries → 繁中 ===');
  const fund = load(FUND, null);
  if (!fund || !fund.bySymbol) { console.log('  no fundamentals.json — skip'); return; }
  const cache = load(CACHE, {});
  const bySymbol = fund.bySymbol;

  const todo = [];
  for (const [sym, q] of Object.entries(bySymbol)) {
    if (!q || !q.summary) continue;
    const h = sha1(q.summary);
    if (cache[h]) q.summaryZh = cache[h];
    else todo.push({ symbol: sym, summary: q.summary, hash: h });
  }
  console.log(`  ${Object.keys(bySymbol).length} symbols · ${todo.length} need translation (rest cached)`);

  if (todo.length && !API_KEY) {
    console.error('  ANTHROPIC_API_KEY not set — keeping English summaries for the new ones.');
  }

  let inTok = 0, outTok = 0, done = 0;
  if (todo.length && API_KEY) {
    for (let i = 0; i < todo.length; i += BATCH) {
      const chunk = todo.slice(i, i + BATCH);
      try {
        const { map, inTok: it, outTok: ot } = await translateBatch(chunk);
        inTok += it; outTok += ot;
        for (const item of chunk) {
          const zh = map[item.symbol] || map[item.symbol.toUpperCase()];
          if (zh && typeof zh === 'string') {
            bySymbol[item.symbol].summaryZh = zh.trim();
            cache[item.hash] = zh.trim();
            done++;
          }
        }
      } catch (e) { console.error('  batch failed:', e.message); }
    }
  }

  fs.writeFileSync(FUND, JSON.stringify(fund, null, 2));
  fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2));
  const cost = (inTok / 1e6) * 1 + (outTok / 1e6) * 5; // Haiku ≈ $1 in / $5 out per Mtok
  console.log(`  translated ${done} new · cache ${Object.keys(cache).length} · tokens in ${inTok} out ${outTok} ≈ $${cost.toFixed(4)}`);
}

main().catch(e => { console.error('FATAL', e.message); process.exit(0); });
