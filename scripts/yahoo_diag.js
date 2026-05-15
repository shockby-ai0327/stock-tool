/**
 * yahoo_diag.js — Test yahoo-finance2 + alternative data sources from GH Actions IPs
 */
import pkg from 'yahoo-finance2';
const yf = pkg.default || pkg;

console.log('yf type:', typeof yf, '| keys:', Object.keys(yf).slice(0, 10).join(','));

async function main() {
  console.log('\n=== yahoo-finance2 quote SPY ===');
  try {
    const q = await yf.quote('SPY');
    console.log('  price:', q?.regularMarketPrice, '| name:', q?.shortName);
  } catch (e) {
    console.log('  FAILED:', e.message.slice(0, 200));
  }

  console.log('\n=== yahoo-finance2 chart SPY (3mo daily) ===');
  try {
    const result = await yf.chart('SPY', {
      period1: new Date(Date.now() - 90 * 86400_000),
      interval: '1d',
    });
    console.log('  quotes:', result?.quotes?.length || 0);
    if (result?.quotes?.length > 0) {
      console.log('  first close:', result.quotes[0]?.close);
      console.log('  last close:',  result.quotes[result.quotes.length-1]?.close);
    }
  } catch (e) {
    console.log('  FAILED:', e.message.slice(0, 200));
  }

  console.log('\n=== yahoo-finance2 chart AAPL (3mo) ===');
  try {
    const result = await yf.chart('AAPL', {
      period1: new Date(Date.now() - 90 * 86400_000),
      interval: '1d',
    });
    console.log('  quotes:', result?.quotes?.length || 0);
  } catch (e) {
    console.log('  FAILED:', e.message.slice(0, 200));
  }

  // Raw Yahoo test (current scan.js approach) — for comparison
  console.log('\n=== raw fetch Yahoo chart SPY (current scan.js approach) ===');
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=3mo', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    });
    console.log('  status:', r.status);
    if (r.ok) {
      const d = await r.json();
      console.log('  result count:', d?.chart?.result?.length || 0);
    }
  } catch(e) {
    console.log('  FAILED:', e.message);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
