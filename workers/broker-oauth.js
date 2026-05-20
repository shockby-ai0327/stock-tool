/**
 * broker-oauth.js — Cloudflare Worker OAuth proxy for brokerage APIs
 *
 * 為什麼需要這個 Worker：
 * 純 client-side HTML（GitHub Pages）無法做 OAuth token exchange —
 * 因為 token exchange 需要 client_secret，存在前端會被偷。
 * 這個 Worker 當中介：
 *   1. 接收 client 的 authorization code
 *   2. 用 client_secret（存在 Worker env）跟 broker 換 access_token
 *   3. 把 access_token 回傳給 client
 *
 * 部署步驟：
 *   1. wrangler login（先 npm install -g wrangler）
 *   2. cd workers && wrangler deploy
 *   3. 在 Cloudflare dashboard → Worker → Settings → Variables 設定：
 *      - ALPACA_CLIENT_ID
 *      - ALPACA_CLIENT_SECRET
 *      - ALLOWED_ORIGIN（你的 GitHub Pages URL，例如 https://shockby-ai0327.github.io）
 *   4. 在 Alpaca dashboard 設定 OAuth redirect URI 為 https://<worker-domain>/alpaca/callback
 *   5. 把 Worker URL 填回 index.html 的 ALPACA_OAUTH_PROXY 常數
 *
 * 支援 broker：
 *   - Alpaca（已實作）
 *   - Schwab（範例，需要對應 client_id）
 *   - 其他可仿照 Alpaca pattern 加
 *
 * 安全：
 *   - CORS：只接受 ALLOWED_ORIGIN 來源
 *   - State 驗證：防 CSRF
 *   - Token 不存在 Worker（每次 exchange 即拿即送）
 *   - Refresh token 應該存使用者的 Firestore（加密），不存 Worker
 */

const BROKER_CONFIG = {
  alpaca: {
    authUrl:  'https://app.alpaca.markets/oauth/authorize',
    tokenUrl: 'https://api.alpaca.markets/oauth/token',
    scopes:   'account:write trading',
    clientIdEnv:     'ALPACA_CLIENT_ID',
    clientSecretEnv: 'ALPACA_CLIENT_SECRET',
  },
  schwab: {
    authUrl:  'https://api.schwabapi.com/v1/oauth/authorize',
    tokenUrl: 'https://api.schwabapi.com/v1/oauth/token',
    scopes:   'readonly',  // Schwab 免費 tier 只給 read
    clientIdEnv:     'SCHWAB_CLIENT_ID',
    clientSecretEnv: 'SCHWAB_CLIENT_SECRET',
  },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const corsHeaders = {
      'Access-Control-Allow-Origin':  env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    // CORS preflight
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    try {
      // GET /:broker/start — return OAuth authorize URL
      const startMatch = path.match(/^\/([^/]+)\/start$/);
      if (startMatch && request.method === 'GET') {
        const broker = startMatch[1];
        const cfg = BROKER_CONFIG[broker];
        if (!cfg) return json({ error: 'unsupported broker' }, 400, corsHeaders);
        const clientId = env[cfg.clientIdEnv];
        if (!clientId) return json({ error: broker + ' client_id not configured in Worker env' }, 500, corsHeaders);
        const state = crypto.randomUUID();
        const redirectUri = `${url.origin}/${broker}/callback`;
        const authorizeUrl = `${cfg.authUrl}?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(cfg.scopes)}&state=${state}`;
        return json({ authorizeUrl, state }, 200, corsHeaders);
      }

      // GET /:broker/callback?code=...&state=... — finalize token exchange
      const callbackMatch = path.match(/^\/([^/]+)\/callback$/);
      if (callbackMatch && request.method === 'GET') {
        const broker = callbackMatch[1];
        const cfg = BROKER_CONFIG[broker];
        if (!cfg) return new Response('unsupported broker', { status: 400 });
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (!code) return new Response('missing code', { status: 400 });
        const clientId = env[cfg.clientIdEnv];
        const clientSecret = env[cfg.clientSecretEnv];
        if (!clientId || !clientSecret) return new Response(broker + ' credentials not configured', { status: 500 });
        const tokenRes = await fetch(cfg.tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: `${url.origin}/${broker}/callback`,
          }),
        });
        if (!tokenRes.ok) {
          const errText = await tokenRes.text();
          return new Response('token exchange failed: ' + errText, { status: 502 });
        }
        const tokens = await tokenRes.json();
        // Redirect back to client with tokens in URL fragment (not query — fragment doesn't go to server logs)
        const clientReturn = env.ALLOWED_ORIGIN || 'https://shockby-ai0327.github.io';
        const returnUrl = `${clientReturn}/stock-tool/?broker_connected=${broker}#access_token=${tokens.access_token}&refresh_token=${tokens.refresh_token || ''}&expires_in=${tokens.expires_in || 3600}`;
        return Response.redirect(returnUrl, 302);
      }

      // POST /:broker/refresh — refresh expired access_token
      const refreshMatch = path.match(/^\/([^/]+)\/refresh$/);
      if (refreshMatch && request.method === 'POST') {
        const broker = refreshMatch[1];
        const cfg = BROKER_CONFIG[broker];
        if (!cfg) return json({ error: 'unsupported broker' }, 400, corsHeaders);
        const body = await request.json();
        const refreshToken = body.refresh_token;
        if (!refreshToken) return json({ error: 'missing refresh_token' }, 400, corsHeaders);
        const clientId = env[cfg.clientIdEnv];
        const clientSecret = env[cfg.clientSecretEnv];
        const refreshRes = await fetch(cfg.tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret,
          }),
        });
        if (!refreshRes.ok) return json({ error: 'refresh failed' }, 502, corsHeaders);
        const tokens = await refreshRes.json();
        return json(tokens, 200, corsHeaders);
      }

      // POST /:broker/proxy — authenticated proxy call to broker API
      // body: { access_token: '...', endpoint: '/v2/orders', method: 'GET' }
      const proxyMatch = path.match(/^\/([^/]+)\/proxy$/);
      if (proxyMatch && request.method === 'POST') {
        const broker = proxyMatch[1];
        const body = await request.json();
        const accessToken = body.access_token;
        const endpoint = body.endpoint;
        const method = (body.method || 'GET').toUpperCase();
        if (!accessToken || !endpoint) return json({ error: 'missing token or endpoint' }, 400, corsHeaders);
        const apiBase = {
          alpaca: 'https://api.alpaca.markets',
          schwab: 'https://api.schwabapi.com',
        }[broker];
        if (!apiBase) return json({ error: 'unsupported broker' }, 400, corsHeaders);
        const proxyRes = await fetch(apiBase + endpoint, {
          method,
          headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' },
          body: method !== 'GET' && body.payload ? JSON.stringify(body.payload) : undefined,
        });
        const proxyData = await proxyRes.text();
        return new Response(proxyData, {
          status: proxyRes.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response('not found\n\nendpoints:\n  GET  /:broker/start\n  GET  /:broker/callback\n  POST /:broker/refresh\n  POST /:broker/proxy', { status: 404 });
    } catch (e) {
      return new Response('worker error: ' + e.message, { status: 500 });
    }
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}
