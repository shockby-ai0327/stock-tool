/**
 * utils.js — Pure utility functions extracted from index.html
 *
 * 第一個 module 示範。沒有 side effects，沒有 DOM 依賴，可以安全測試。
 * 未來其他 module 可以 import 這裡的 helpers。
 *
 * 對應 index.html line numbers (參考用):
 *   - escapeHtml / safeHref:   ~755
 *   - fmtChineseNumber:        ~3520
 *   - isTw / currencySymbol:   ~3517
 *   - _normalizeDate:          ~3870
 *   - _parseCsvRow:            ~3860
 */

// ─── XSS 防護 ──────────────────────────────────────────────────────────
export function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const escapeAttr = escapeHtml;

export function safeHref(s) {
  if (!s) return '#';
  const trimmed = String(s).trim();
  if (/^javascript:|^data:|^vbscript:/i.test(trimmed)) return '#';
  return escapeAttr(trimmed);
}

// ─── Ticker / 幣別 ──────────────────────────────────────────────────────
export function isTw(ticker) {
  return ticker && (ticker.endsWith('.TW') || ticker.endsWith('.TWO'));
}

export function currencySymbol(ticker) {
  return isTw(ticker) ? 'NT$' : '$';
}

// ─── 數字格式化（萬/億） ────────────────────────────────────────────────
export function fmtChineseNumber(v) {
  if (v == null || isNaN(v)) return 'N/A';
  const abs = Math.abs(v);
  if (abs >= 1e8) return (v / 1e8).toFixed(2) + '億';
  if (abs >= 1e4) return (v / 1e4).toFixed(1) + '萬';
  return Math.round(v).toLocaleString();
}

export function fmtCompact(v) {
  if (v == null || isNaN(v)) return 'N/A';
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return Math.round(v).toLocaleString();
}

// ─── 日期 ──────────────────────────────────────────────────────────────
export function normalizeDate(s) {
  if (!s) return null;
  const v = String(s).trim().replace(/\//g, '-');
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(v)) {
    const [y, m, d] = v.split('-');
    return y + '-' + m.padStart(2, '0') + '-' + d.padStart(2, '0');
  }
  if (/^\d{8}$/.test(v)) return v.slice(0, 4) + '-' + v.slice(4, 6) + '-' + v.slice(6, 8);
  if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(v)) {
    const [m, d, y] = v.split('-');
    return y + '-' + m.padStart(2, '0') + '-' + d.padStart(2, '0');
  }
  const dt = new Date(v);
  if (!isNaN(dt)) return dt.toISOString().slice(0, 10);
  return null;
}

// ─── CSV parser（支援引號內逗號） ──────────────────────────────────────
export function parseCsvRow(line, sep = ',') {
  const result = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (c === sep && !inQuote) {
      result.push(cur);
      cur = '';
    } else cur += c;
  }
  result.push(cur);
  return result;
}

// ─── 防禦式時間戳 normalize ─────────────────────────────────────────────
// 處理 backtest.js 舊資料用秒、新資料用 ms 的混合（信任破洞 #1 修法的延伸）
export function normalizeTsToMs(ts) {
  if (ts == null) return null;
  return ts < 1e12 ? ts * 1000 : ts;
}

// ─── 統計小工具 ─────────────────────────────────────────────────────────
export function mean(arr) {
  return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
}

export function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / (arr.length - 1);
  return Math.sqrt(v);
}

export function sharpe(returns, riskFree = 0) {
  if (returns.length < 2) return 0;
  const m = mean(returns) - riskFree;
  const sd = stddev(returns);
  return sd > 0 ? m / sd : 0;
}
