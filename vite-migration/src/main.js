/**
 * main.js — Entry point for Vite-built version
 *
 * 目前狀態：scaffold 階段
 * 真正的 SPA 還在 /index.html（單檔 13k 行）。這裡是逐步遷移目標。
 *
 * 遷移策略（不破壞 production）：
 *   1. 先把純函式（utils, math, parsers）搬進 src/lib/
 *   2. 把 Firebase 邏輯搬進 src/lib/firebase.js（modular SDK 已用）
 *   3. 把每個分頁拆 module（dashboard / scanner / journal / portfolio / education）
 *   4. inline onclick 改 addEventListener
 *   5. 最後把 index.html 改成 <script type="module" src="/src/main.js">
 *
 * 過程中 production index.html 不動，所有改動先在 vite-migration/ 驗證。
 */

import * as utils from './lib/utils.js';

// 暴露到 window 供舊 code 漸進取用
window._utils = utils;

console.log('[vite-migration] utils module loaded:', Object.keys(utils).length, 'helpers');
