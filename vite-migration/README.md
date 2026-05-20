# Vite Migration — 漸進拆分 index.html

## 為什麼需要這個

Plan agent 給目前 13k 行單檔架構 **2/10**。痛點：
- VSCode/Cursor LSP 在 ~8000 行後 type inference 放棄
- 304 個 top-level functions + 35 個 `window._xxx` 全域狀態
- 加新功能要 grep 5 次才知道誰會踩到
- 「一週內加一個功能不破壞另外三個」答案是：不可能

但完整遷移是 1-2 週工程，期間網站可能會壞。所以採**漸進式**：

## 策略

1. **不動 production**：根目錄 `/index.html` 繼續服務，使用者無感
2. **vite-migration/ 是平行 sandbox**：在這裡實驗、驗證 module 拆法
3. **逐步搬遷**：每次只搬一個 module（utils → firebase → journal → ...）
4. **完成的 module 從 index.html 砍掉，改 import**（最後階段才做）

## 目前狀態

```
vite-migration/
├── package.json          ← 依賴聲明
├── vite.config.js        ← Vite 配置（dev / build）
├── src/
│   ├── index.html        ← 測試 entry
│   ├── main.js           ← Module 載入點
│   └── lib/
│       └── utils.js      ← ✅ 已抽：純工具函式 13 個
```

## 啟動 dev server

```bash
cd vite-migration
npm install        # 第一次
npm run dev        # 開 http://localhost:5173
```

## 下一步搬遷順序

按「依賴從少到多」排：

1. ✅ **utils.js**（已做）— escapeHtml / fmtChineseNumber / parseCsvRow 等純函式
2. **state.js** — 集中 35 個 `window._xxx` 全域狀態到單一 store
3. **firebase.js** — Auth + Firestore 已用 modular SDK，搬進來
4. **ohlcv.js** — Yahoo proxy + cache 邏輯
5. **journal.js** — Journal CRUD + 計算
6. **scanner.js** — RS Leader + Triple Resonance render
7. **dashboard.js** — Morning Brief render
8. **stock.js** — 個股分析頁
9. **education.js** — 教學頁
10. **alerts.js** — 條件式警報

每個 module 完成後：
- 把對應的 code 從 `index.html` 砍掉
- 改 `import { ... } from './lib/xxx.js'`
- 暴露需要的全域到 `window` 維持 onclick 相容

## 為什麼不一次做完

每個 module 都有跨依賴（journal 用 utils + firebase + state；scanner 用 utils + ohlcv + state...）。
一次搬完 = 一次性破壞所有 inline `onclick`，需要全面回歸測試。
分批搬 = 每次驗證一個小範圍，壞了能快速回滾。

## 何時完成「整體遷移」

當以下都滿足時，就可以把根 `index.html` 換成 Vite build 產物：
- [ ] 所有 module 都搬完
- [ ] 所有 inline `onclick` 改成 `addEventListener`
- [ ] CI 跑 lint + type check 過
- [ ] 至少一週 dual-deploy 驗證（Vite build 跟原 HTML 並存）

預估時間：solo dev 大約 3-6 週業餘時間。
