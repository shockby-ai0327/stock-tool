/**
 * yahoo_diag.js — Diagnose what Yahoo returns from GitHub Actions IPs.
 * Run via workflow_dispatch on a new short workflow.
 */
import fetch from 'node-fetch';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function diag(label, url, headers = {}) {
  console.log(`\n=== ${label} ===`);
  console.log(`URL: ${url}`);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, ...headers },
      signal: AbortSignal.timeout(10000),
    });
    console.log(`Status: ${res.status} ${res.statusText}`);
    console.log(`Content-Type: ${res.headers.get('content-type')}`);
    console.log(`X-Yahoo-Request-Id: ${res.headers.get('x-yahoo-request-id') || 'none'}`);
    const body = await res.text();
    console.log(`Body length: ${body.length}`);
    console.log(`Body (first 500 chars):\n${body.slice(0, 500)}`);
  } catch (e) {
    console.log(`EXCEPTION: ${e.message}`);
  }
}

await diag('Chart SPY (no extra headers)',
  'https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=1mo');

await new Promise(r => setTimeout(r, 1500));

await diag('Chart AAPL (no extra headers)',
  'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1mo');

await new Promise(r => setTimeout(r, 1500));

await diag('Screener day_gainers',
  'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_gainers&start=0&count=5&formatted=false');

await new Promise(r => setTimeout(r, 1500));

await diag('query2 chart SPY',
  'https://query2.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=1mo');

console.log('\n=== Done ===');
