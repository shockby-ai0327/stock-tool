/**
 * qlib_factors.js — 8 個從 Microsoft Qlib Alpha158 挑出來的動能因子
 *
 * 為什麼選這 8 個（vs Alpib 全 158 個）：
 *   - 跟 Minervini SEPA + IBD CAN SLIM 動能風格高度相關
 *   - 只需要 OHLCV 就能算（不需要財報資料）
 *   - 每個都有明確 hypothesis（不是 "data mining"）
 *
 * 參考：
 *   Microsoft Qlib Alpha158 paper:
 *   https://github.com/microsoft/qlib/blob/main/qlib/contrib/data/handler.py
 *
 * 不是直接 copy 公式 — 我們重新表達為「對動能交易者直覺有用」的方向。
 */

// Helper: simple moving average
function sma(arr, period) {
  if (arr.length < period) return null;
  let sum = 0;
  for (let i = arr.length - period; i < arr.length; i++) sum += arr[i];
  return sum / period;
}

// Helper: standard deviation
function stddev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
  const variance = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

// Helper: clamp 0-99 normalize from raw → score
function clampScore(v, low, high) {
  if (v == null || isNaN(v)) return null;
  if (v <= low) return 0;
  if (v >= high) return 99;
  return Math.round((v - low) / (high - low) * 99);
}

/**
 * 1. KMID60 — K-line midbody strength (60-day)
 *    (close - open) / open 的 60 日累積動能
 *    → 持續陽線 = 機構主導
 */
function kmid60(opens, closes) {
  if (closes.length < 60 || opens.length < 60) return null;
  let sum = 0;
  for (let i = closes.length - 60; i < closes.length; i++) {
    sum += (closes[i] - opens[i]) / opens[i];
  }
  return sum;
}

/**
 * 2. MAX60_REL — 現價相對 60 日高點的距離
 *    1.0 = 創新高，0.95 = 距高 5%，等等
 *    → 創新高股票繼續創新高（Jegadeesh-Titman）
 */
function max60Rel(highs, closes) {
  if (highs.length < 60) return null;
  const recent60 = highs.slice(-60);
  const high60 = Math.max(...recent60);
  return closes[closes.length - 1] / high60;
}

/**
 * 3. ROC20 — 20-day rate of change
 *    短期動能 — 4 週累積報酬
 *    → Minervini "stage 2" 標準之一：4 週 +5% 以上
 */
function roc20(closes) {
  if (closes.length < 21) return null;
  const cur = closes[closes.length - 1];
  const past = closes[closes.length - 21];
  return (cur - past) / past;
}

/**
 * 4. STD20_INV — 20 日波動率的「倒數」normalize 後分數
 *    波動低 = 整理乾淨 = base 完成 → 後續突破力道強
 *    Minervini VCP 核心：volatility contraction 後爆發
 */
function std20Inv(closes) {
  if (closes.length < 21) return null;
  const recent = closes.slice(-21);
  const returns = [];
  for (let i = 1; i < recent.length; i++) {
    returns.push((recent[i] - recent[i - 1]) / recent[i - 1]);
  }
  const sd = stddev(returns);
  // 倒數 — 越低越好，但限制 max
  return sd > 0 ? 1 / (1 + sd * 50) : null;  // 介於 0-1
}

/**
 * 5. VOL_RATIO20 — 20 日成交量 / 過去 60 日成交量
 *    >1.5 = 量能擴張 = 機構介入
 *    Minervini "高量突破" 確認
 */
function volRatio20(volumes) {
  if (volumes.length < 80) return null;
  const recent20 = volumes.slice(-20).reduce((s, v) => s + v, 0) / 20;
  const prior60 = volumes.slice(-80, -20).reduce((s, v) => s + v, 0) / 60;
  return prior60 > 0 ? recent20 / prior60 : null;
}

/**
 * 6. VSUMP60_RATIO — 60 日上漲日成交量 / 全部成交量
 *    >0.55 = 量主要集中在漲日 = 籌碼乾淨吸籌
 *    Qlib Alpha158 真正有用的 chip 訊號
 */
function vsump60Ratio(closes, volumes) {
  if (closes.length < 61) return null;
  let upVol = 0, totalVol = 0;
  for (let i = closes.length - 60; i < closes.length; i++) {
    const v = volumes[i] || 0;
    totalVol += v;
    if (i > 0 && closes[i] > closes[i - 1]) upVol += v;
  }
  return totalVol > 0 ? upVol / totalVol : null;
}

/**
 * 7. MA_ALIGN — MA5 > MA10 > MA20 > MA60 排列分（0-1）
 *    完美排列 = 標準 Stage 2（Weinstein）
 *    每對符合加 0.25
 */
function maAlign(closes) {
  if (closes.length < 60) return null;
  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  if (ma5 == null || ma10 == null || ma20 == null || ma60 == null) return null;
  let score = 0;
  if (ma5 > ma10) score += 0.25;
  if (ma10 > ma20) score += 0.25;
  if (ma20 > ma60) score += 0.25;
  if (closes[closes.length - 1] > ma5) score += 0.25;
  return score;
}

/**
 * 8. ACCEL_60 — 加速度：近 30 日 ROC vs 前 30 日 ROC
 *    >1.2 = 動能加速 = Druckenmiller「leader follows leader」
 *    Minervini 也強調 progressive acceleration
 */
function accel60(closes) {
  if (closes.length < 61) return null;
  const c0 = closes[closes.length - 61];
  const c30 = closes[closes.length - 31];
  const c60 = closes[closes.length - 1];
  if (!c0 || !c30) return null;
  const prior = (c30 - c0) / c0;
  const recent = (c60 - c30) / c30;
  if (Math.abs(prior) < 0.01) return null;  // avoid divide by tiny
  return recent / prior;
}

/**
 * 主入口：給 OHLCV arrays 算 8 個因子 + 綜合 Qlib momentum score (0-99)
 */
export function computeQlibFactors(ohlcv) {
  if (!ohlcv || ohlcv.length < 80) return null;
  const opens   = ohlcv.map(d => d.o);
  const highs   = ohlcv.map(d => d.h);
  const closes  = ohlcv.map(d => d.c);
  const volumes = ohlcv.map(d => d.v || 0);

  const f = {
    kmid60:       kmid60(opens, closes),
    max60Rel:     max60Rel(highs, closes),
    roc20:        roc20(closes),
    std20Inv:     std20Inv(closes),
    volRatio20:   volRatio20(volumes),
    vsump60Ratio: vsump60Ratio(closes, volumes),
    maAlign:      maAlign(closes),
    accel60:      accel60(closes),
  };

  // 8 個 sub-scores normalize 到 0-99，equal-weighted 合併
  const subs = {
    kmid:       clampScore(f.kmid60,       -0.5,    0.8),   // -50% 到 +80% 累積
    breakout:   clampScore(f.max60Rel,      0.85,   1.0),   // 距高 15% 到 創新高
    roc20:      clampScore(f.roc20,        -0.05,   0.30),  // -5% 到 +30%
    contract:   clampScore(f.std20Inv,      0.2,    0.7),   // VCP contraction
    volExp:     clampScore(f.volRatio20,    0.8,    2.5),   // 量比 0.8-2.5x
    chip:       clampScore(f.vsump60Ratio,  0.4,    0.65),  // 上漲日量佔比
    align:      clampScore(f.maAlign,       0,      1),     // MA 排列
    accel:      clampScore(f.accel60,       0.5,    2),     // 動能加速
  };

  const valid = Object.values(subs).filter(v => v != null);
  const qlibScore = valid.length
    ? Math.round(valid.reduce((s, v) => s + v, 0) / valid.length)
    : null;

  return {
    factors:    f,
    subScores:  subs,
    qlibScore:  qlibScore,  // 0-99
  };
}
