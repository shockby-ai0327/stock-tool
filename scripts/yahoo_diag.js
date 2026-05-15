/**
 * yahoo_diag.js — Test yahoo-finance2 npm library
 * (replaces previous raw-fetch diagnostic now that we've confirmed Yahoo
 * is blocking direct query1/query2 access from GitHub Actions IPs)
 */
import yahooFinance from 'yahoo-finance2';

async function main() {
  console.log('=== yahoo-finance2 historical SPY ===');
  try {
    const result = await yahooFinance.historical('SPY', {
      period1: new Date(Date.now() - 365 * 86400_000),
      period2: new Date(),
      interval: '1d',
    });
    console.log('SPY history length:', result.length);
    if (result.length > 0) {
      console.log('First:', result[0]);
      console.log('Last:', result[result.length - 1]);
    }
  } catch (e) {
    console.log('historical FAILED:', e.message);
  }

  console.log('\n=== yahoo-finance2 quote SPY ===');
  try {
    const quote = await yahooFinance.quote('SPY');
    console.log('quote:', JSON.stringify(quote, null, 2).slice(0, 500));
  } catch (e) {
    console.log('quote FAILED:', e.message);
  }

  console.log('\n=== yahoo-finance2 chart SPY (3mo) ===');
  try {
    const result = await yahooFinance.chart('SPY', {
      period1: new Date(Date.now() - 90 * 86400_000),
      interval: '1d',
    });
    console.log('chart quotes length:', result?.quotes?.length);
    if (result?.quotes?.length > 0) {
      console.log('First close:', result.quotes[0]?.close);
      console.log('Last close:', result.quotes[result.quotes.length - 1]?.close);
    }
  } catch (e) {
    console.log('chart FAILED:', e.message);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
