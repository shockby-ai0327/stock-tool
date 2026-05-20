/**
 * broker-oauth.js — Cloudflare Worker for Alpaca Live Trading proxy
 *
 * 2026-05-21 改設計：放棄 OAuth（Alpaca 個人用戶申請會被擋），改用 Worker 直接保管 API key。
 *
 * 原理：
 *   1. Alpaca Live API key+secret 存在 Worker secrets（不在前端）
 *   2. 前端透過你的 GitHub Pages 呼叫 Worker（CORS 限定 ALLOWED_ORIGIN）
 *   3. Worker 用 secrets 呼叫 Alpaca，回傳結果
 *   4. 即使 view-source 也看不到 key
 *
 * 安全模型：
 *   - CORS 只允許 ALLOWED_ORIGIN（你的 GitHub Pages）
 *   - 沒有「執行交易」endpoint（只 READ） — 即使被攻擊也只能查資料
 *   - 如果要加交易功能，請加 shared-secret header 驗證
 *
 * 部署：
 *   wrangler deploy
 *   wrangler secret put ALLOWED_ORIGIN       # https://shockby-ai0327.github.io
 *   wrangler secret put ALPACA_LIVE_KEY_ID   # AKxxx (Live Trading key, 不是 PK)
 *   wrangler secret put ALPACA_LIVE_SECRET   # Live secret
 *
 * Endpoints（全 GET）：
 *   /alpaca/account      帳號資訊
 *   /alpaca/positions    當前持倉
 *   /alpaca/orders       訂單（支援 ?status=filled&limit=200&direction=desc）
 *   /alpaca/portfolio/history?period=1M&timeframe=1D   組合歷史
 *   /health              健康檢查（公開）
 */

const ALPACA_LIVE_BASE = 'https://api.alpaca.markets/v2';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const allowed = env.ALLOWED_ORIGIN || '*';
    const corsHeaders = {
      'Access-Control-Allow-Origin':  allowed,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    // Health check (no secrets needed)
    if (path === '/health') {
      const keyConfigured = !!env.ALPACA_LIVE_KEY_ID && !!env.ALPACA_LIVE_SECRET;
      return json({
        ok: true,
        alpaca_keys_configured: keyConfigured,
        allowed_origin: env.ALLOWED_ORIGIN ? 'set' : 'unset',
      }, 200, corsHeaders);
    }

    // Origin enforcement (defense in depth — CORS plus server-side check)
    const origin = request.headers.get('Origin') || '';
    if (env.ALLOWED_ORIGIN && origin && origin !== env.ALLOWED_ORIGIN) {
      return json({ error: 'origin not allowed' }, 403, corsHeaders);
    }

    // All /alpaca/* require live keys configured
    if (path.startsWith('/alpaca/')) {
      if (!env.ALPACA_LIVE_KEY_ID || !env.ALPACA_LIVE_SECRET) {
        return json({ error: 'Live keys not configured. Run: wrangler secret put ALPACA_LIVE_KEY_ID + ALPACA_LIVE_SECRET' }, 500, corsHeaders);
      }
      // Whitelist of allowed Alpaca endpoints (read-only)
      const allowedPaths = [
        { pattern: /^\/alpaca\/account$/,            target: '/account' },
        { pattern: /^\/alpaca\/positions$/,          target: '/positions' },
        { pattern: /^\/alpaca\/orders$/,             target: '/orders' },
        { pattern: /^\/alpaca\/portfolio\/history$/, target: '/account/portfolio/history' },
      ];
      const match = allowedPaths.find(p => p.pattern.test(path));
      if (!match) return json({ error: 'endpoint not whitelisted' }, 404, corsHeaders);
      // Pass through query params
      const targetUrl = ALPACA_LIVE_BASE + match.target + url.search;
      try {
        const r = await fetch(targetUrl, {
          headers: {
            'APCA-API-KEY-ID':     env.ALPACA_LIVE_KEY_ID,
            'APCA-API-SECRET-KEY': env.ALPACA_LIVE_SECRET,
            'Accept': 'application/json',
          },
        });
        const body = await r.text();
        return new Response(body, {
          status: r.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return json({ error: 'alpaca upstream error: ' + e.message }, 502, corsHeaders);
      }
    }

    return new Response(
      'stock-tool-broker-oauth\n\n' +
      'GET /health\n' +
      'GET /alpaca/account\n' +
      'GET /alpaca/positions\n' +
      'GET /alpaca/orders\n' +
      'GET /alpaca/portfolio/history\n',
      { status: 200, headers: { 'Content-Type': 'text/plain' } }
    );
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}
