# Broker OAuth Proxy — Cloudflare Worker

純前端（GitHub Pages）無法做 OAuth token exchange，因為 token exchange 需要 `client_secret`，
存在前端會被偷。這個 Worker 當中介：使用者按「連線券商」→ 跳到券商授權頁 → 券商
redirect 回 Worker → Worker 用 client_secret 換 access_token → 把 token 回傳給前端。

## 為什麼選 Cloudflare Workers

- 100,000 requests/day free tier 對個人用足夠
- 全球 edge 部署延遲低
- 不需要 cold start
- 比 Vercel/Netlify functions 更接近一個獨立的 server

## 部署步驟

### 1. 安裝 wrangler CLI

```bash
npm install -g wrangler
wrangler login   # 開啟瀏覽器登入 Cloudflare
```

### 2. 部署 Worker

```bash
cd workers
wrangler deploy
```

部署完會看到一個 URL，例如：
```
https://stock-tool-broker-oauth.YOUR-SUBDOMAIN.workers.dev
```

### 3. 在 Alpaca dashboard 註冊 OAuth app

1. 登入 https://app.alpaca.markets/
2. 進入 **Dashboard → OAuth Apps**
3. 點 **Create New OAuth App**
4. **Redirect URI** 填：`https://stock-tool-broker-oauth.YOUR-SUBDOMAIN.workers.dev/alpaca/callback`
5. 拿到 **Client ID** 和 **Client Secret**

### 4. 在 Worker 設定環境變數

```bash
wrangler secret put ALPACA_CLIENT_ID
# 貼上你的 Client ID

wrangler secret put ALPACA_CLIENT_SECRET
# 貼上你的 Client Secret

wrangler secret put ALLOWED_ORIGIN
# 貼上 https://shockby-ai0327.github.io
```

或在 Cloudflare dashboard：Worker → Settings → Variables → Environment Variables 設定。

### 5. 在 index.html 設定 Worker URL

打開 `index.html`，找到 `ALPACA_OAUTH_PROXY` 常數，改成你的 Worker URL：

```javascript
const ALPACA_OAUTH_PROXY = 'https://stock-tool-broker-oauth.YOUR-SUBDOMAIN.workers.dev';
```

## Schwab 整合（選用）

Schwab API 需要正式的 Developer Portal 註冊：
1. 申請 https://developer.schwab.com/
2. 等核准（可能 1-2 週）
3. 取得 Client ID + Secret
4. 在 Worker env 設定 `SCHWAB_CLIENT_ID` + `SCHWAB_CLIENT_SECRET`
5. 在 Schwab dashboard 設 Redirect URI 為 `https://<worker>/schwab/callback`

## 安全注意

- **Refresh token 不要存在 Worker** — 應該存在 Firestore 加密過後的格式
- **CORS** 設成只接受你的 GitHub Pages URL，不要用 `*`
- Worker 程式碼 review：[broker-oauth.js](./broker-oauth.js)
- Cloudflare Worker 預設 HTTPS-only

## API endpoints

| Method | Path | 用途 |
|---|---|---|
| GET | `/:broker/start` | 取得 OAuth authorize URL（前端跳轉用） |
| GET | `/:broker/callback` | OAuth callback，跟券商換 token 後 redirect 回 client |
| POST | `/:broker/refresh` | refresh expired access_token |
| POST | `/:broker/proxy` | authenticated proxy call to broker API |

## 為什麼不接券商 API key 模式（不走 OAuth）

某些券商（如 Alpaca）允許不走 OAuth、直接用 API key 認證。看起來更簡單，
但 API key 必須存在 client（localStorage）→ 跟 GitHub PAT 同個風險。

**Paper trading** 我們在主程式直接做了（key 被偷只是假錢損失，可接受）。
**Real trading 一定要走 OAuth**，因為 OAuth access_token 是短效的（1 小時），
被偷影響有限；refresh_token 加密存在使用者的 Firestore，比 client localStorage 安全。

## 開發 / Debug

```bash
wrangler dev   # 本地起伺服器
# 在 index.html 把 ALPACA_OAUTH_PROXY 改成 http://localhost:8787 測試
```

```bash
wrangler tail  # 看 production logs
```
