// Smoke test for Wave 1 helpers — hits real Yahoo APIs with crumb auth.
// Usage: node scripts/test_wave1.js
import fetch from 'node-fetch';

const DELAY = ms => new Promise(r => setTimeout(r, ms));
const YF_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const yfSession = { cookie: '', crumb: '' };

async function yfInitSession() {
  try {
    const seedRes = await fetch('https://fc.yahoo.com/', {
      headers: { 'User-Agent': YF_UA, 'Accept': '*/*' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    const setCookie = seedRes.headers.raw?.()['set-cookie'] || seedRes.headers.get('set-cookie');
    const cookies = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
    yfSession.cookie = cookies.map(c => c.split(';')[0]).join('; ');
  } catch {}
  try {
    const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': YF_UA, 'Cookie': yfSession.cookie },
      signal: AbortSignal.timeout(10000),
    });
    if (crumbRes.ok) {
      const text = (await crumbRes.text()).trim();
      if (text && text.length < 40 && !text.startsWith('<')) yfSession.crumb = text;
    }
  } catch {}
  console.log(`  YF session: cookie=${yfSession.cookie ? 'set ('+yfSession.cookie.length+'b)' : 'missing'} crumb=${yfSession.crumb ? 'set: '+yfSession.crumb : 'missing'}`);
}

async function yfFetch(url, retries = 2) {
  const headers = { 'User-Agent': YF_UA, 'Accept': 'application/json' };
  if (yfSession.cookie) headers['Cookie'] = yfSession.cookie;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
      if (res.status === 429) { await DELAY(2000 * (i + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await DELAY(1500);
    }
  }
}

function withCrumb(url) {
  if (!yfSession.crumb) return url;
  return url + (url.includes('?') ? '&' : '?') + 'crumb=' + encodeURIComponent(yfSession.crumb);
}

async function getSectorInfo(symbol) {
  const url = withCrumb(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=assetProfile,summaryProfile`);
  const data = await yfFetch(url);
  const profile = data?.quoteSummary?.result?.[0]?.assetProfile
               || data?.quoteSummary?.result?.[0]?.summaryProfile;
  return { sector: profile?.sector || null, industry: profile?.industry || null };
}

async function getQuoteSummary(symbol) {
  const modules = 'calendarEvents,defaultKeyStatistics,upgradeDowngradeHistory,recommendationTrend,earningsHistory';
  const url = withCrumb(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`);
  const data = await yfFetch(url);
  return data?.quoteSummary?.result?.[0] || null;
}

// ── Test ──
await yfInitSession();
console.log('');

const testTickers = ['NVDA', 'AAPL', 'ONDS'];

console.log('=== Sector / Industry probe ===');
for (const sym of testTickers) {
  try {
    const info = await getSectorInfo(sym);
    console.log(`  ${sym}: sector="${info.sector}" industry="${info.industry}"`);
  } catch (e) { console.log(`  ${sym}: FAIL ${e.message}`); }
  await DELAY(500);
}

console.log('\n=== Quote summary probe ===');
for (const sym of testTickers) {
  try {
    const summary = await getQuoteSummary(sym);
    if (!summary) { console.log(`  ${sym}: NULL`); continue; }
    const cal = summary.calendarEvents?.earnings?.earningsDate;
    const ks = summary.defaultKeyStatistics || {};
    const hist = summary.upgradeDowngradeHistory?.history || [];
    const trend = summary.recommendationTrend?.trend?.[0];
    console.log(`  ${sym}:`);
    console.log(`    earningsDate=${JSON.stringify(cal)}`);
    console.log(`    shortPctOfFloat=${ks.shortPercentOfFloat?.raw ?? ks.shortPercentOfFloat}`);
    console.log(`    shortRatio=${ks.shortRatio?.raw ?? ks.shortRatio}`);
    console.log(`    upgrade/downgrade hist count=${hist.length}`);
    console.log(`    earningsHistory count=${(summary.earningsHistory?.history || []).length}`);
    console.log(`    recommendation: ${JSON.stringify(trend)}`);
  } catch (e) { console.log(`  ${sym}: FAIL ${e.message}`); }
  await DELAY(500);
}

console.log('\nDone.\n');
