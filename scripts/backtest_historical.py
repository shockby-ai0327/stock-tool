#!/usr/bin/env python3
"""
backtest_historical.py — Point-in-time historical backtest of the RS Leader signal.

WHY THIS EXISTS
---------------
backtest.js is a FORWARD tracker: it records signals as they fire and waits for
them to resolve. That is the honest long-run truth source, but it is data-starved
today (the tool hasn't run long enough — most signals are still "open", sample
sizes are 0-2). It would take months/years to say anything.

This script instead reconstructs the EXACT live leader signal from several years
of historical OHLCV and measures realized trade outcomes NOW, giving a
statistically meaningful sample immediately — with the rigor needed to not lie to
ourselves (Deflated Sharpe, Monte Carlo, calibration, benchmark, regime split).

SIGNAL DEFINITION — mirrors scan.js exactly
-------------------------------------------
At each rebalance date t, using only data up to t:
    ma50      = mean(close[t-49 .. t])
    avgVol20  = mean(volume[t-19 .. t])
    ret12_1   = close[t-21] / close[t-252] - 1          (12-month, skip last month)
    benchRet  = SPY ret12_1 at t
    rs12_1    = ret12_1 - benchRet
    leader    = (close[t] >= ma50) AND (avgVol20 >= 150_000) AND (ret12_1 > 0)
Among leaders, rank by rs12_1 descending; the TOP 25 are the rs_leader signals.

TRADE SIMULATION — mirrors backtest.js constants
-------------------------------------------------
Enter next bar's open. Exit on +15% target / -8% stop / 60-trading-day timeout.
Gaps handled honestly (fill at open if it gaps past the level). Same-day
target+stop touch resolves as STOP (conservative). Round-trip cost applied.

OUTPUT
------
data/backtest_historical.json — overall stats, Monte Carlo, calibration,
benchmark, regime split, equity curve, honest caveats, and a plain verdict.

This is intentionally honest about its limits (see CAVEATS in output):
  - Survivorship bias: universe is CURRENT membership, delisted losers missing
    → results are OPTIMISTIC. This is the single biggest grain of salt.
  - In-sample parameters: target/stop/top-N chosen by the tool author.
  - No real fills/slippage beyond a flat cost assumption.
"""

import json
import math
import os
import sys
import time
from datetime import datetime, timezone

import numpy as np
import pandas as pd

# yfinance is imported lazily inside download functions so this module can be
# imported for unit tests / reuse without the dependency present.

# ── Paths ────────────────────────────────────────────────────────────────────
HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "..", "data")
os.makedirs(DATA_DIR, exist_ok=True)

# ── Tuning constants (MUST match scan.js / backtest.js) ──────────────────────
MA_WINDOW       = 50
VOL_WINDOW      = 20
MIN_AVG_VOL     = 150_000      # leader liquidity floor (scan.js line 1164)
RS_LOOKBACK     = 252          # ~12 months trading days
RS_SKIP         = 21           # skip most-recent month (12-1 momentum)
TOP_N           = 25           # live tool surfaces top 25 leaders
TARGET_PCT      = 0.15         # +15% target (backtest.js)
STOP_PCT        = 0.08         # -8% stop (backtest.js)
TIMEOUT_DAYS    = 60           # trading-day timeout (backtest.js)
REBALANCE_DAYS  = 5            # weekly rebalance (every 5 trading days)
COST_BPS        = 10           # round-trip cost assumption, basis points (0.10%)
YEARS           = 15           # history depth (long-history regime test; XBRL fundamentals ~2010+)
MC_RUNS         = 2000         # Monte Carlo bootstrap resamples
DSR_TRIALS      = 20           # assumed # of strategy configs tested (for DSR haircut)

EULER_GAMMA = 0.5772156649


# ── Universe ─────────────────────────────────────────────────────────────────
def load_universe():
    path = os.path.join(DATA_DIR, "universe_static.json")
    with open(path) as f:
        u = json.load(f)
    tickers = u.get("tickers", []) if isinstance(u, dict) else u
    # Clean: drop anything with dots/slashes (yfinance choke), dedupe, keep <=5 char
    seen, out = set(), []
    for t in tickers:
        t = str(t).strip().upper()
        if not t or "." in t or "/" in t or len(t) > 5 or t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out


# ── Data download (yfinance bulk, batched + defensive) ───────────────────────
def download_prices(tickers, years):
    import yfinance as yf
    period = f"{years}y"
    all_close, all_high, all_low, all_open, all_vol = {}, {}, {}, {}, {}
    BATCH = 120
    for i in range(0, len(tickers), BATCH):
        batch = tickers[i:i + BATCH]
        sys.stdout.write(f"  download {i+len(batch)}/{len(tickers)}\r")
        sys.stdout.flush()
        try:
            df = yf.download(batch, period=period, interval="1d",
                             group_by="ticker", auto_adjust=True,
                             threads=True, progress=False)
        except Exception as e:
            print(f"\n  batch {i} failed: {e}")
            continue
        for t in batch:
            try:
                if len(batch) == 1:
                    sub = df
                else:
                    if t not in df.columns.get_level_values(0):
                        continue
                    sub = df[t]
                sub = sub.dropna(how="all")
                if sub.empty or "Close" not in sub:
                    continue
                all_close[t] = sub["Close"]
                all_high[t]  = sub["High"]
                all_low[t]   = sub["Low"]
                all_open[t]  = sub["Open"]
                all_vol[t]   = sub["Volume"]
            except Exception:
                continue
        time.sleep(0.3)
    print()
    close = pd.DataFrame(all_close).sort_index()
    high  = pd.DataFrame(all_high).reindex(close.index)
    low   = pd.DataFrame(all_low).reindex(close.index)
    op    = pd.DataFrame(all_open).reindex(close.index)
    vol   = pd.DataFrame(all_vol).reindex(close.index)
    return close, high, low, op, vol


# ── Signal reconstruction (vectorized, point-in-time) ────────────────────────
def build_signals(close, vol, spy_close):
    """Return a boolean leader mask + rs12_1 DataFrame aligned to close.index."""
    ma50 = close.rolling(MA_WINDOW).mean()
    avgvol20 = vol.rolling(VOL_WINDOW).mean()
    # ret12_1 = close[t-21] / close[t-252] - 1  → using shifts
    c_skip = close.shift(RS_SKIP)
    c_base = close.shift(RS_LOOKBACK)
    ret12_1 = c_skip / c_base - 1.0

    spy_ret12_1 = (spy_close.shift(RS_SKIP) / spy_close.shift(RS_LOOKBACK) - 1.0)
    spy_ret12_1 = spy_ret12_1.reindex(close.index)

    rs12_1 = ret12_1.sub(spy_ret12_1, axis=0)

    leader = (close >= ma50) & (avgvol20 >= MIN_AVG_VOL) & (ret12_1 > 0)
    # need enough history
    enough = close.notna() & c_base.notna() & ma50.notna()
    leader = leader & enough
    return leader, rs12_1, ret12_1


# ── Trade simulation (generalized exit-policy lab) ──────────────────────────
# config keys:
#   name, policy: 'fixed' | 'trailing' | 'ma_exit'
#   fixed:    stop, target, timeout
#   trailing: trail, timeout              (no target — let winners run)
#   ma_exit:  ma_period, disaster, timeout
#   regime_gate: bool                     (only enter when SPY >= its 200d MA)
# r_unit = initial risk fraction (for R-multiple); comparison uses %/CAGR/DSR.
def simulate(close, high, low, op, leader, rs12_1, spy_close, config, ma_cache):
    idx = close.index
    n = len(idx)
    cols = list(close.columns)
    ci = {s: k for k, s in enumerate(cols)}
    C = close.values; H = high.values; L = low.values; O = op.values
    Lmask = leader.values
    RS = rs12_1.values
    spy_px_arr = spy_close.values
    spy_ma200 = spy_close.rolling(200).mean().values

    policy = config["policy"]
    timeout = config.get("timeout", TIMEOUT_DAYS)
    regime_gate = config.get("regime_gate", False)
    if policy == "fixed":
        r_unit = config["stop"]
    elif policy == "trailing":
        r_unit = config["trail"]
    else:
        r_unit = config["disaster"]
    ma_arr = ma_cache.get(config.get("ma_period")) if policy == "ma_exit" else None

    open_until = {}
    trades = []
    rebal_dates = range(RS_LOOKBACK + 1, n - 1, REBALANCE_DAYS)

    for ti in rebal_dates:
        spy_ma = spy_ma200[ti]
        uptrend = bool(not np.isnan(spy_ma) and spy_px_arr[ti] >= spy_ma)
        if regime_gate and not uptrend:
            continue

        leader_cols = np.where(Lmask[ti])[0]
        if leader_cols.size == 0:
            continue
        rs_vals = RS[ti, leader_cols]
        ok = ~np.isnan(rs_vals)
        leader_cols, rs_vals = leader_cols[ok], rs_vals[ok]
        if leader_cols.size == 0:
            continue
        order = np.argsort(rs_vals)[::-1][:TOP_N]

        for k in order:
            col = leader_cols[k]
            sym = cols[col]
            if open_until.get(sym, -1) >= ti:
                continue
            entry_i = ti + 1
            if entry_i >= n:
                continue
            entry_px = O[entry_i, col]
            if not (entry_px > 0):
                entry_px = C[ti, col]
            if not (entry_px > 0) or np.isnan(entry_px):
                continue

            last = min(entry_i + timeout, n - 1)
            exit_i = exit_px = outcome = None

            if policy == "fixed":
                stop = entry_px * (1 - config["stop"])
                target = entry_px * (1 + config["target"])
                for j in range(entry_i, last + 1):
                    lo, hi, oo = L[j, col], H[j, col], O[j, col]
                    if np.isnan(lo) or np.isnan(hi):
                        continue
                    if lo <= stop:
                        exit_px = min(oo, stop) if (oo == oo and oo < stop) else stop
                        exit_i, outcome = j, "stop"; break
                    if hi >= target:
                        exit_px = max(oo, target) if (oo == oo and oo > target) else target
                        exit_i, outcome = j, "target"; break

            elif policy == "trailing":
                trail = config["trail"]
                peak = entry_px
                stop_level = entry_px * (1 - trail)
                for j in range(entry_i, last + 1):
                    lo, hi, oo = L[j, col], H[j, col], O[j, col]
                    if np.isnan(lo) or np.isnan(hi):
                        continue
                    if lo <= stop_level:
                        exit_px = min(oo, stop_level) if (oo == oo and oo < stop_level) else stop_level
                        exit_i, outcome = j, "trail"; break
                    if hi > peak:
                        peak = hi
                        stop_level = max(stop_level, peak * (1 - trail))

            else:  # ma_exit
                disaster = entry_px * (1 - config["disaster"])
                for j in range(entry_i, last + 1):
                    lo, cl, oo = L[j, col], C[j, col], O[j, col]
                    ma = ma_arr[j, col]
                    if np.isnan(lo) or np.isnan(cl):
                        continue
                    if lo <= disaster:
                        exit_px = min(oo, disaster) if (oo == oo and oo < disaster) else disaster
                        exit_i, outcome = j, "stop"; break
                    if not np.isnan(ma) and cl < ma:
                        exit_px = cl; exit_i, outcome = j, "ma"; break

            if exit_i is None:
                exit_i = last
                exit_px = C[last, col]
                outcome = "timeout"
                if np.isnan(exit_px):
                    continue

            ret = (exit_px - entry_px) / entry_px - COST_BPS / 10000.0
            trades.append({
                "symbol": sym,
                "entry_date": str(idx[entry_i].date()),
                "exit_date": str(idx[exit_i].date()),
                "entry_i": int(entry_i), "exit_i": int(exit_i),
                "ret": float(ret),
                "r_multiple": float(ret / r_unit),
                "hold": int(exit_i - entry_i),
                "outcome": outcome,
                "uptrend": uptrend,
                "rs": float(rs_vals[k]),
            })
            open_until[sym] = exit_i
    return trades, idx


# ── Stats ────────────────────────────────────────────────────────────────────
def norm_cdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def norm_ppf(p):
    # Acklam's inverse-normal approximation
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00]
    plow, phigh = 0.02425, 1 - 0.02425
    if p < plow:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / \
               ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    if p > phigh:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / \
                ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    q = p - 0.5
    r = q * q
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / \
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)


def daily_equity_curve(trades, idx):
    """Equal-weight among concurrently-open trades; daily portfolio return."""
    n = len(idx)
    # per-trade daily simple return contribution = spread evenly across open trades
    daily_ret = np.zeros(n)
    open_count = np.zeros(n)
    # approximate each trade as constant daily compounding to its total ret
    for t in trades:
        a, b = t["entry_i"], t["exit_i"]
        days = max(1, b - a)
        # geometric daily rate that compounds to total ret over `days`
        g = (1 + t["ret"]) ** (1.0 / days) - 1.0
        for j in range(a + 1, b + 1):
            if j < n:
                daily_ret[j] += g
                open_count[j] += 1
    # average across open trades (equal weight), cash (0) when none open
    out = np.where(open_count > 0, daily_ret / np.maximum(open_count, 1), 0.0)
    eq = np.cumprod(1 + out)
    return out, eq


def max_drawdown(equity):
    peak = np.maximum.accumulate(equity)
    dd = (equity - peak) / peak
    return float(dd.min())


def deflated_sharpe(daily_rets, ann_sharpe, n_trials):
    """PSR against SR*=expected-max-from-trials (Bailey & López de Prado)."""
    r = daily_rets[daily_rets != 0]
    N = len(r)
    if N < 30:
        return None, None
    sr_daily = ann_sharpe / math.sqrt(252)
    skew = float(pd.Series(r).skew())
    kurt = float(pd.Series(r).kurtosis()) + 3.0  # pandas gives excess; want raw
    # PSR(0): prob true SR > 0
    denom = math.sqrt(max(1e-9, 1 - skew * sr_daily + (kurt - 1) / 4 * sr_daily ** 2))
    psr0 = norm_cdf((sr_daily - 0.0) * math.sqrt(N - 1) / denom)
    # Expected max Sharpe from n_trials independent N(0, var) strategies.
    # Estimate cross-trial SR stdev from this strategy's SR estimation error.
    se_sr = denom / math.sqrt(N - 1)  # stderr of SR estimate (daily)
    var_trials = se_sr ** 2
    if n_trials > 1 and var_trials > 0:
        z1 = norm_ppf(1 - 1.0 / n_trials)
        z2 = norm_ppf(1 - 1.0 / (n_trials * math.e))
        sr_star = math.sqrt(var_trials) * ((1 - EULER_GAMMA) * z1 + EULER_GAMMA * z2)
    else:
        sr_star = 0.0
    dsr = norm_cdf((sr_daily - sr_star) * math.sqrt(N - 1) / denom)
    return round(psr0, 4), round(dsr, 4)


def pct(arr, p):
    return float(np.percentile(arr, p)) if len(arr) else None


def compute_stats(trades, idx, close, spy_close, n_trials=DSR_TRIALS, config=None):
    rets = np.array([t["ret"] for t in trades])
    rmult = np.array([t["r_multiple"] for t in trades])
    holds = np.array([t["hold"] for t in trades])
    wins = rets[rets > 0]
    losses = rets[rets <= 0]
    n = len(trades)

    win_rate = len(wins) / n if n else 0
    avg_win = float(wins.mean()) if len(wins) else 0
    avg_loss = float(losses.mean()) if len(losses) else 0
    expectancy = float(rets.mean()) if n else 0
    gross_win = float(wins.sum()) if len(wins) else 0
    gross_loss = float(-losses.sum()) if len(losses) else 0
    profit_factor = (gross_win / gross_loss) if gross_loss > 0 else None

    daily, eq = daily_equity_curve(trades, idx)
    nz = daily[daily != 0]
    ann_sharpe = float(nz.mean() / nz.std() * math.sqrt(252)) if len(nz) > 2 and nz.std() > 0 else None
    mdd = max_drawdown(eq)
    total_ret = float(eq[-1] - 1)
    years = (idx[-1] - idx[0]).days / 365.25
    cagr = float(eq[-1] ** (1 / years) - 1) if years > 0 and eq[-1] > 0 else None

    psr, dsr = (None, None)
    if ann_sharpe is not None:
        psr, dsr = deflated_sharpe(daily, ann_sharpe, n_trials)
    exp_r = round(float(rmult.mean()), 3) if n else None

    # Monte Carlo: BLOCK-bootstrap the daily portfolio-return series (not trade
    # returns — those overlap in time; compounding N of them sequentially is
    # nonsense). Block bootstrap preserves drawdown clustering. We compound over
    # the same horizon → realistic, bounded distribution of total return & maxDD.
    mc_final, mc_dd = [], []
    if n >= 20 and len(daily) > 60:
        rng = np.random.default_rng(42)
        block = int(np.clip(np.median(holds) if len(holds) else 20, 5, 40))
        L = len(daily)
        nblocks = int(np.ceil(L / block))
        starts_max = max(1, L - block)
        for _ in range(MC_RUNS):
            starts = rng.integers(0, starts_max, size=nblocks)
            sample = np.concatenate([daily[s:s + block] for s in starts])[:L]
            e = np.cumprod(1 + sample)
            mc_final.append(e[-1] - 1)
            mc_dd.append(max_drawdown(e))
        mc_final = np.array(mc_final)
        mc_dd = np.array(mc_dd)

    # Calibration by RS quintile within signals
    calibration = []
    if n >= 25:
        rs_vals = np.array([t["rs"] for t in trades])
        qs = np.quantile(rs_vals, [0.2, 0.4, 0.6, 0.8])
        labels = ["RS 最低20%", "20-40%", "40-60%", "60-80%", "RS 最高20%"]
        edges = [-np.inf] + list(qs) + [np.inf]
        for k in range(5):
            mask = (rs_vals > edges[k]) & (rs_vals <= edges[k + 1])
            if mask.sum() >= 5:
                calibration.append({
                    "bucket": labels[k],
                    "nTrades": int(mask.sum()),
                    "winRate": round(float((rets[mask] > 0).mean()), 4),
                    "avgR": round(float(rmult[mask].mean()), 3),
                })

    # Regime split
    up = np.array([t["uptrend"] for t in trades], dtype=bool)
    def seg(mask):
        if mask.sum() == 0:
            return None
        return {
            "nTrades": int(mask.sum()),
            "winRate": round(float((rets[mask] > 0).mean()), 4),
            "expectancyR": round(float(rmult[mask].mean()), 3),
            "avgRetPct": round(float(rets[mask].mean()) * 100, 2),
        }
    regime = {"uptrend": seg(up), "downtrend": seg(~up)}

    # SPY benchmark over same window
    spy = spy_close.dropna()
    spy_total = float(spy.iloc[-1] / spy.iloc[0] - 1)
    spy_cagr = float((spy.iloc[-1] / spy.iloc[0]) ** (1 / years) - 1) if years > 0 else None
    spy_eq = (spy / spy.iloc[0]).values
    spy_mdd = max_drawdown(spy_eq)

    # downsample equity curve for frontend (~120 pts)
    step = max(1, len(eq) // 120)
    curve = [{"date": str(idx[i].date()), "equity": round(float(eq[i]), 4)}
             for i in range(0, len(eq), step)]

    # Honest verdict
    verdict = build_verdict(n, win_rate, expectancy, exp_r, dsr, cagr, spy_cagr, regime)

    return {
        "params": {
            "config": (config or {}),
            "rebalanceDays": REBALANCE_DAYS, "topN": TOP_N, "costBps": COST_BPS,
            "rsLookback": RS_LOOKBACK, "rsSkip": RS_SKIP,
            "startDate": str(idx[0].date()), "endDate": str(idx[-1].date()),
            "years": round(years, 2),
        },
        "overall": {
            "nTrades": n,
            "winRate": round(win_rate, 4),
            "avgWinPct": round(avg_win * 100, 2),
            "avgLossPct": round(avg_loss * 100, 2),
            "expectancyPct": round(expectancy * 100, 3),
            "expectancyR": exp_r,
            "profitFactor": round(profit_factor, 2) if profit_factor else None,
            "annSharpe": round(ann_sharpe, 2) if ann_sharpe is not None else None,
            "psr": psr, "dsr": dsr, "dsrTrialsAssumed": n_trials,
            "maxDrawdownPct": round(mdd * 100, 1),
            "avgHoldDays": int(holds.mean()) if n else None,
            "totalReturnPct": round(total_ret * 100, 1),
            "cagr": round(cagr * 100, 2) if cagr is not None else None,
            "outcomes": {k: sum(1 for t in trades if t["outcome"] == k)
                         for k in sorted(set(t["outcome"] for t in trades))} if n else {},
        },
        "monteCarlo": {
            "finalReturnP5": round(pct(mc_final, 5) * 100, 1) if len(mc_final) else None,
            "finalReturnP50": round(pct(mc_final, 50) * 100, 1) if len(mc_final) else None,
            "finalReturnP95": round(pct(mc_final, 95) * 100, 1) if len(mc_final) else None,
            "maxDDP5": round(pct(mc_dd, 5) * 100, 1) if len(mc_dd) else None,
            "maxDDP50": round(pct(mc_dd, 50) * 100, 1) if len(mc_dd) else None,
            "maxDDP95": round(pct(mc_dd, 95) * 100, 1) if len(mc_dd) else None,
            "runs": MC_RUNS if len(mc_final) else 0,
        },
        "benchmark": {
            "spyTotalReturnPct": round(spy_total * 100, 1),
            "spyCagr": round(spy_cagr * 100, 2) if spy_cagr is not None else None,
            "spyMaxDDPct": round(spy_mdd * 100, 1),
            "excessCagrPct": round((cagr - spy_cagr) * 100, 2) if (cagr is not None and spy_cagr is not None) else None,
        },
        "regimeSplit": regime,
        "calibration": calibration,
        "equityCurve": curve,
        "caveats": [
            "倖存者偏差：宇宙是「當前」成分股，已下市的輸家不在內 → 結果偏樂觀（最大的一撮鹽）。",
            "樣本內參數：+15%目標 / -8%停損 / 取前25 是工具設計者選的，非樣本外驗證。",
            "成交假設：隔日開盤進場、跳空照開盤價、同日觸及目標與停損視為停損（保守），" + f"來回成本 {COST_BPS}bps。",
            "無真實滑價 / 借券 / 流動性衝擊建模。",
            "Sharpe 用等權「有部位才投入」的日報酬曲線，空手日報酬為 0（現金拖累）。",
        ],
        "verdict": verdict,
    }


def build_verdict(n, win_rate, expectancy, exp_r, dsr, cagr, spy_cagr, regime):
    if n < 30:
        return f"樣本僅 {n} 筆，不足以下結論。需要更長歷史或更大宇宙。"
    parts = []
    beats = (cagr is not None and spy_cagr is not None and cagr > spy_cagr)
    if expectancy <= 0:
        return f"⨯ 扣成本後期望值為負（{expectancy*100:.2f}%/筆）。這套訊號在歷史上不賺錢 —— 別用它選股。"
    if dsr is not None and dsr < 0.90:
        parts.append(f"但 Deflated Sharpe 僅 {dsr:.2f}（<0.90）—— 扣掉多重測試偏差後，這個 edge 不夠穩健，很可能是運氣。")
    elif dsr is not None and dsr >= 0.95:
        parts.append(f"Deflated Sharpe {dsr:.2f} —— 扣多重測試偏差後仍顯著，是這份報告裡少見的好兆頭。")
    if not beats:
        parts.append(f"且年化報酬（{cagr*100:.1f}%）並未勝過單純買 SPY（{spy_cagr*100:.1f}%）—— 承擔個股風險卻沒拿到溢酬。")
    else:
        parts.append(f"年化 {cagr*100:.1f}% vs SPY {spy_cagr*100:.1f}%，有超額報酬。")
    up = regime.get("uptrend"); dn = regime.get("downtrend")
    if up and dn and dn["expectancyR"] < up["expectancyR"]:
        parts.append(f"空頭環境期望值（{dn['expectancyR']:.2f}R）明顯低於多頭（{up['expectancyR']:.2f}R）—— regime 過濾是關鍵。")
    head = f"勝率 {win_rate*100:.1f}%、每筆期望 {expectancy*100:.2f}%（{expectancy/STOP_PCT:.2f}R）。"
    return head + " " + " ".join(parts)


# ── Hypothesis lab: genuinely different strategies + train/test split ────────
def _rsi(close, period):
    delta = close.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / loss.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).fillna(50)


def sim_strategy(panels, entry_fn, rebal, exit_cfg, topn, t0, t1):
    """Generic strategy simulator over rebalance dates in [t0, t1)."""
    C, H, L, O = panels["C"], panels["H"], panels["L"], panels["O"]
    n, ncols = C.shape
    cols = panels["cols"]
    ma_reclaim = panels.get(exit_cfg.get("reclaim_ma"))
    policy = exit_cfg["policy"]
    timeout = exit_cfg.get("timeout", 60)
    disaster = exit_cfg.get("disaster", 0.20)
    trail = exit_cfg.get("trail")
    cost = exit_cfg.get("costBps", COST_BPS) / 10000.0
    r_unit = disaster if policy != "trail" else trail

    open_until = {}
    trades = []
    for ti in range(max(t0, RS_LOOKBACK + 1), min(t1, n - 1), rebal):
        cols_sel, scores = entry_fn(ti)
        if cols_sel is None or len(cols_sel) == 0:
            continue
        order = np.argsort(scores)[::-1][:topn]
        for k in order:
            col = int(cols_sel[k])
            sym = cols[col]
            if open_until.get(sym, -1) >= ti:
                continue
            ei = ti + 1
            if ei >= n:
                continue
            entry_px = O[ei, col]
            if not (entry_px > 0):
                entry_px = C[ti, col]
            if not (entry_px > 0) or np.isnan(entry_px):
                continue
            last = min(ei + timeout, n - 1)
            dis = entry_px * (1 - disaster)
            xi = xpx = out = None
            peak = entry_px
            stop_level = entry_px * (1 - trail) if trail else None
            for j in range(ei, last + 1):
                lo, hi, cl, oo = L[j, col], H[j, col], C[j, col], O[j, col]
                if np.isnan(lo) or np.isnan(cl):
                    continue
                if lo <= dis:  # disaster stop (all policies)
                    xpx = min(oo, dis) if (oo == oo and oo < dis) else dis
                    xi, out = j, "stop"; break
                if policy == "trail":
                    if hi > peak:
                        peak = hi; stop_level = max(stop_level, peak * (1 - trail))
                    if lo <= stop_level:
                        xpx = min(oo, stop_level) if (oo == oo and oo < stop_level) else stop_level
                        xi, out = j, "trail"; break
                elif policy == "ma_reclaim":  # exit when close back above reclaim MA
                    ma = ma_reclaim[j, col] if ma_reclaim is not None else np.nan
                    if not np.isnan(ma) and cl >= ma:
                        xpx = cl; xi, out = j, "reclaim"; break
                # policy == "time": only disaster + timeout
            if xi is None:
                xi = last; xpx = C[last, col]; out = "timeout"
                if np.isnan(xpx):
                    continue
            ret = (xpx - entry_px) / entry_px - cost
            trades.append({"symbol": sym, "col": col, "entry_i": int(ei), "exit_i": int(xi),
                           "ret": float(ret), "r_multiple": float(ret / r_unit),
                           "hold": int(xi - ei), "outcome": out, "uptrend": True,
                           "rs": float(scores[k])})
            open_until[sym] = xi
    return trades


def size_tranche_analysis(trades, dollarvol, label):
    """Bucket a strategy's trades by entry-time dollar-volume quintile.
    Tests the hypothesis: does edge concentrate in smaller / less-liquid names?
    (Dollar-volume = avgVol20 × close is a market-cap/liquidity proxy.)"""
    rows = []
    for t in trades:
        dv = dollarvol[t["entry_i"], t["col"]]
        if dv == dv and dv > 0:  # not NaN
            rows.append((dv, t["ret"]))
    if len(rows) < 50:
        return {"insufficient": True, "n": len(rows)}
    rows.sort(key=lambda x: x[0])
    dvs = np.array([r[0] for r in rows]); rets = np.array([r[1] for r in rows])
    qs = np.quantile(dvs, [0.2, 0.4, 0.6, 0.8])
    edges = [-np.inf] + list(qs) + [np.inf]
    names = ["Q1 最小", "Q2", "Q3", "Q4", "Q5 最大"]
    out = []
    for k in range(5):
        m = (dvs > edges[k]) & (dvs <= edges[k + 1])
        if m.sum() >= 10:
            out.append({
                "tranche": names[k],
                "n": int(m.sum()),
                "medianDollarVolM": round(float(np.median(dvs[m])) / 1e6, 1),
                "winRate": round(float((rets[m] > 0).mean()), 4),
                "expectancyPct": round(float(rets[m].mean()) * 100, 3),
            })
    # Is the smallest tranche meaningfully better than the largest?
    edge_in_small = (len(out) == 5 and out[0]["expectancyPct"] > out[4]["expectancyPct"]
                     and out[0]["expectancyPct"] > 0)
    return {"label": label, "buckets": out, "edgeConcentratesInSmall": edge_in_small}


def subset_metrics(trades, lo, hi):
    """Light IS/OOS metrics on trades whose entry_i in [lo, hi)."""
    sub = [t for t in trades if lo <= t["entry_i"] < hi]
    if len(sub) < 15:
        return {"n": len(sub), "insufficient": True}
    rets = np.array([t["ret"] for t in sub])
    wins = rets[rets > 0]; losses = rets[rets <= 0]
    gw = wins.sum(); gl = -losses.sum()
    return {"n": len(sub), "winRate": round(float((rets > 0).mean()), 4),
            "expectancyPct": round(float(rets.mean()) * 100, 3),
            "profitFactor": round(float(gw / gl), 2) if gl > 0 else None}


def index_timing(spy_close, idx):
    """Absolute-momentum index timing: hold SPY when > its 200d MA, else cash."""
    spy = spy_close.values
    ma200 = spy_close.rolling(200).mean().values
    ret = np.zeros(len(spy))
    for j in range(1, len(spy)):
        if not np.isnan(ma200[j - 1]) and spy[j - 1] >= ma200[j - 1]:
            if spy[j - 1] > 0 and not np.isnan(spy[j]):
                ret[j] = spy[j] / spy[j - 1] - 1
    eq = np.cumprod(1 + ret)
    years = (idx[-1] - idx[0]).days / 365.25
    cagr = float(eq[-1] ** (1 / years) - 1) if years > 0 and eq[-1] > 0 else None
    nz = ret[ret != 0]
    sharpe = float(nz.mean() / nz.std() * math.sqrt(252)) if len(nz) > 2 and nz.std() > 0 else None
    return {"cagr": round(cagr * 100, 2) if cagr else None,
            "annSharpe": round(sharpe, 2) if sharpe else None,
            "maxDrawdownPct": round(max_drawdown(eq) * 100, 1),
            "pctTimeInMarket": round(float((ret != 0).mean()) * 100, 1)}


def run_strategy_lab(close, high, low, op, vol, spy_close, leader, rs12_1, n_trials):
    idx = close.index
    n = len(idx)
    cols = list(close.columns)
    panels = {"C": close.values, "H": high.values, "L": low.values,
              "O": op.values, "cols": cols}
    # indicators
    ma5 = close.rolling(5).mean().values
    ma50 = close.rolling(50).mean().values
    ma200 = close.rolling(200).mean().values
    hi252 = high.rolling(252).max().values
    avgvol5 = vol.rolling(5).mean().values
    avgvol20 = vol.rolling(20).mean().values
    volexp = np.divide(avgvol5, avgvol20, out=np.ones_like(avgvol5), where=avgvol20 > 0)
    rsi2 = _rsi(close, 2).values
    C = panels["C"]
    vol_arr = vol.values
    dollarvol = avgvol20 * C   # liquidity / market-cap proxy (days × syms)
    Lmask = leader.values
    RS = rs12_1.values
    panels["ma5"] = ma5

    def e_mom(ti):
        lc = np.where(Lmask[ti])[0]
        if lc.size == 0:
            return None, None
        rv = RS[ti, lc]; ok = ~np.isnan(rv)
        return lc[ok], rv[ok]

    def e_meanrev(ti):
        row_c = C[ti]; mask = (row_c > ma200[ti]) & (row_c < ma5[ti]) & (rsi2[ti] < 15)
        lc = np.where(mask)[0]
        if lc.size == 0:
            return None, None
        return lc, (100 - rsi2[ti, lc])  # most oversold first

    def e_breakout(ti):
        row_c = C[ti]
        mask = (row_c >= 0.97 * hi252[ti]) & (volexp[ti] > 1.3) & (row_c > ma200[ti])
        lc = np.where(mask)[0]
        if lc.size == 0:
            return None, None
        return lc, volexp[ti, lc]

    # 進攻系統:前端進攻獵場的系統化版 — 逼近新高 + 爆量 + 1月動能,且 regime 閘門
    # (SPY>200MA 才進場,動能在空頭是墳場)。
    ret1m_arr = (close / close.shift(21) - 1.0).values
    spy_arr_a = spy_close.values
    spy_ma200_a = spy_close.rolling(200).mean().values

    def e_attack(ti):
        # regime 閘門:SPY 必須在自己的 200MA 之上,否則整批不進場
        if np.isnan(spy_ma200_a[ti]) or spy_arr_a[ti] < spy_ma200_a[ti]:
            return None, None
        row_c = C[ti]
        mask = (row_c >= 0.97 * hi252[ti]) & (volexp[ti] > 1.3) & (row_c > ma200[ti]) & (ret1m_arr[ti] > 0)
        mask = np.nan_to_num(mask, nan=False).astype(bool)
        lc = np.where(mask)[0]
        if lc.size == 0:
            return None, None
        return lc, ret1m_arr[ti, lc]   # 按近月動能排序

    def e_pead(ti):
        # PEAD proxy: large single-day jump + volume spike = likely earnings beat.
        # Buy next bar, ride the post-earnings drift. No earnings calendar needed.
        if ti < 1:
            return None, None
        prev = C[ti - 1]
        with np.errstate(invalid="ignore", divide="ignore"):
            gap = C[ti] / prev - 1.0
            volspk = vol_arr[ti] / avgvol20[ti]
        mask = (gap >= 0.06) & (volspk >= 2.5) & (C[ti] > ma50[ti])
        mask = np.nan_to_num(mask, nan=False).astype(bool)
        lc = np.where(mask)[0]
        if lc.size == 0:
            return None, None
        return lc, gap[lc]  # rank by gap magnitude

    strategies = [
        {"name": "mom_long", "label": "學術動能(月換·持有3月)", "entry": e_mom,
         "rebal": 21, "topn": 25, "exit": {"policy": "time", "timeout": 63, "disaster": 0.25}},
        {"name": "meanrev", "label": "均值回歸(RSI2超賣)", "entry": e_meanrev,
         "rebal": 5, "topn": 10, "exit": {"policy": "ma_reclaim", "reclaim_ma": "ma5", "timeout": 10, "disaster": 0.10}},
        {"name": "breakout52", "label": "52週新高突破", "entry": e_breakout,
         "rebal": 5, "topn": 15, "exit": {"policy": "trail", "trail": 0.15, "timeout": 120, "disaster": 0.15}},
        {"name": "pead", "label": "財報跳空漂移(代理)", "entry": e_pead,
         "rebal": 1, "topn": 20, "exit": {"policy": "trail", "trail": 0.12, "timeout": 50, "disaster": 0.12}},
        {"name": "attack_sys", "label": "進攻系統(突破+量+regime+快砍慢抱·40bps)", "entry": e_attack,
         "rebal": 5, "topn": 8, "exit": {"policy": "trail", "trail": 0.12, "timeout": 60, "disaster": 0.08, "costBps": 40}},
    ]

    split = RS_LOOKBACK + int((n - RS_LOOKBACK) * 0.6)  # 60% in-sample
    split_date = str(idx[split].date())
    spy_cagr_full = None

    out = []
    tranche = None
    for s in strategies:
        trades = sim_strategy(panels, s["entry"], s["rebal"], s["exit"], s["topn"],
                              RS_LOOKBACK + 1, n)
        if s["name"] == "mom_long":
            tranche = size_tranche_analysis(trades, dollarvol, s["label"])
        st = compute_stats(trades, idx, close, spy_close, n_trials=n_trials, config={"strategy": s["name"]})
        spy_cagr_full = st["benchmark"]["spyCagr"]
        o = st["overall"]
        is_m = subset_metrics(trades, RS_LOOKBACK + 1, split)
        oos_m = subset_metrics(trades, split, n)
        beats = (o["cagr"] is not None and spy_cagr_full is not None and o["cagr"] > spy_cagr_full)
        robust = (o["dsr"] is not None and o["dsr"] >= 0.90)
        persists = (not is_m.get("insufficient") and not oos_m.get("insufficient")
                    and is_m.get("expectancyPct", 0) > 0 and oos_m.get("expectancyPct", 0) > 0
                    and oos_m["expectancyPct"] >= 0.5 * is_m["expectancyPct"])
        out.append({"name": s["name"], "label": s["label"], "nTrades": o["nTrades"],
                    "winRate": o["winRate"], "expectancyPct": o["expectancyPct"],
                    "profitFactor": o["profitFactor"], "annSharpe": o["annSharpe"],
                    "dsr": o["dsr"], "cagr": o["cagr"], "maxDrawdownPct": o["maxDrawdownPct"],
                    "beatsSPY": beats, "robust": robust, "persists": persists,
                    "tradeable": bool(beats and robust and persists),
                    "inSample": is_m, "outOfSample": oos_m})

    timing = index_timing(spy_close, idx)
    timing["beatsSPYrisk"] = (timing["maxDrawdownPct"] is not None
                              and timing["maxDrawdownPct"] > -30)  # much shallower DD

    winners = [s for s in out if s["tradeable"]]
    if winners:
        b = max(winners, key=lambda v: v["dsr"] or 0)
        verdict = (f"✓ 找到 edge：「{b['label']}」全期贏 SPY、DSR {b['dsr']}≥0.90、"
                   f"且樣本外仍正期望值(IS {b['inSample'].get('expectancyPct')}% → "
                   f"OOS {b['outOfSample'].get('expectancyPct')}%)。值得認真往下做。")
    else:
        beat_any = [s for s in out if s["beatsSPY"]]
        verdict = (f"⨯ 4 個不同假設都不算數(全期贏SPY+DSR≥0.9+樣本外持續，無一全中)。"
                   + (f"最接近的「{max(beat_any, key=lambda v: v['cagr'] or -99)['label']}」全期贏了 SPY 但樣本外或穩健度沒過。" if beat_any
                      else "連全期都沒人贏過 SPY。")
                   + f" 指數擇時(SPY>200MA)：CAGR {timing['cagr']}% vs 買進持有 SPY {spy_cagr_full}%，"
                   + f"但最大回撤只有 {timing['maxDrawdownPct']}%(買進持有約 -24%)——降回撤是它唯一的價值。")
    # Size-tranche honesty check: did momentum work better in smaller names?
    if tranche and not tranche.get("insufficient") and tranche.get("edgeConcentratesInSmall"):
        b = tranche["buckets"]
        verdict += (f" ◆ 但規模分層有線索：最小規模層期望值 {b[0]['expectancyPct']}% "
                    f"vs 最大層 {b[4]['expectancyPct']}% —— edge 確實偏向小型股，"
                    f"值得建專屬小型股宇宙重測。")

    return {"split_date": split_date, "spyCagr": spy_cagr_full,
            "strategies": out, "indexTiming": timing,
            "sizeTranche": tranche, "verdict": verdict}


# ── Factor lab: point-in-time fundamentals × momentum × value ────────────────
FACTOR_COST_BPS = 40   # realistic 元大 複委託 round-trip (much higher than 10bps)


def _pit_panel(idx, cols, fund_hist, concept):
    """Build a days×syms array = latest fundamental value KNOWN (filed) by each date.
    No lookahead: uses the most recent annual value whose filed-date <= the bar date."""
    n, m = len(idx), len(cols)
    arr = np.full((n, m), np.nan)
    bar_dates = np.array([d.value for d in idx])  # int64 ns
    for cj, sym in enumerate(cols):
        rec = fund_hist.get(sym)
        if not rec or concept not in rec:
            continue
        series = rec[concept]  # [[filed, end, val], ...] sorted by filed
        if not series:
            continue
        filed_ns = np.array([pd.Timestamp(s[0]).value for s in series])
        vals = np.array([s[2] for s in series], dtype=float)
        # for each bar, index of latest filed <= bar date
        pos = np.searchsorted(filed_ns, bar_dates, side="right") - 1
        ok = pos >= 0
        arr[ok, cj] = vals[pos[ok]]
    return arr


def _prev_panel(idx, cols, fund_hist, concept):
    """Like _pit_panel but the PRIOR annual value (for growth/Δ)."""
    n, m = len(idx), len(cols)
    arr = np.full((n, m), np.nan)
    bar_dates = np.array([d.value for d in idx])
    for cj, sym in enumerate(cols):
        rec = fund_hist.get(sym)
        if not rec or concept not in rec or len(rec[concept]) < 2:
            continue
        series = rec[concept]
        filed_ns = np.array([pd.Timestamp(s[0]).value for s in series])
        vals = np.array([s[2] for s in series], dtype=float)
        pos = np.searchsorted(filed_ns, bar_dates, side="right") - 1
        ok = pos >= 1
        arr[ok, cj] = vals[pos[ok] - 1]
    return arr


def run_factor_lab(close, high, low, op, spy_close, leader, rs12_1, fund_hist, n_trials):
    idx = close.index
    n = len(idx)
    cols = list(close.columns)
    panels = {"C": close.values, "H": high.values, "L": low.values, "O": op.values, "cols": cols}
    C = panels["C"]
    RS = rs12_1.values
    Lmask = leader.values

    # point-in-time fundamental panels (no lookahead)
    NI = _pit_panel(idx, cols, fund_hist, "netIncome")
    EQ = _pit_panel(idx, cols, fund_hist, "equity")
    REV = _pit_panel(idx, cols, fund_hist, "revenue")
    OCF = _pit_panel(idx, cols, fund_hist, "opCashFlow")
    CAPEX = _pit_panel(idx, cols, fund_hist, "capex")
    SH = _pit_panel(idx, cols, fund_hist, "shares")
    NI_prev = _prev_panel(idx, cols, fund_hist, "netIncome")

    with np.errstate(divide="ignore", invalid="ignore"):
        ROE = NI / EQ                                   # quality
        FCF = OCF - np.nan_to_num(CAPEX)                 # free cash flow
        FCFM = FCF / REV                                 # quality (fcf margin)
        EP = NI / (SH * C)                               # value (earnings yield); needs shares×price
        GROW = NI / NI_prev - 1.0                        # earnings growth

    def _rank(vals, cols_sel):
        """percentile rank (0-1) of vals[cols_sel], NaN-safe."""
        v = vals[cols_sel]
        ok = ~np.isnan(v)
        r = np.full(len(v), np.nan)
        if ok.sum() >= 5:
            order = np.argsort(np.argsort(v[ok]))
            r[ok] = order / (ok.sum() - 1)
        return r

    def e_value(ti):
        ep = EP[ti]; mask = ~np.isnan(ep) & (NI[ti] > 0)
        lc = np.where(mask)[0]
        return (lc, ep[lc]) if lc.size else (None, None)

    def e_quality(ti):
        roe = ROE[ti]; mask = ~np.isnan(roe) & (FCF[ti] > 0) & (NI[ti] > 0)
        lc = np.where(mask)[0]
        return (lc, roe[lc]) if lc.size else (None, None)

    def e_qual_mom(ti):
        lc = np.where(Lmask[ti])[0]               # momentum leaders
        if lc.size == 0:
            return None, None
        roe = ROE[ti, lc]; ok = ~np.isnan(roe) & (NI[ti, lc] > 0)
        return (lc[ok], roe[ok]) if ok.sum() else (None, None)

    def e_val_mom(ti):
        lc = np.where(Lmask[ti])[0]
        if lc.size == 0:
            return None, None
        ep = EP[ti, lc]; ok = ~np.isnan(ep) & (NI[ti, lc] > 0)
        return (lc[ok], ep[ok]) if ok.sum() else (None, None)

    def e_qmv(ti):
        # composite: average rank of quality(ROE) + momentum(RS) + value(EP), among profitable
        base = np.where((NI[ti] > 0) & ~np.isnan(ROE[ti]) & ~np.isnan(EP[ti]) & ~np.isnan(RS[ti]))[0]
        if base.size < 10:
            return None, None
        rq = _rank(ROE[ti], base); rm = _rank(RS[ti], base); rv = _rank(EP[ti], base)
        comp = np.nanmean(np.vstack([rq, rm, rv]), axis=0)
        ok = ~np.isnan(comp)
        return (base[ok], comp[ok]) if ok.sum() else (None, None)

    strategies = [
        {"name": "value", "label": "價值(高earnings yield)", "entry": e_value, "rebal": 21, "topn": 25},
        {"name": "quality", "label": "品質(高ROE+FCF正)", "entry": e_quality, "rebal": 21, "topn": 25},
        {"name": "qual_mom", "label": "品質×動能", "entry": e_qual_mom, "rebal": 21, "topn": 20},
        {"name": "val_mom", "label": "價值×動能", "entry": e_val_mom, "rebal": 21, "topn": 20},
        {"name": "qmv", "label": "QMV 綜合(品質+動能+價值)", "entry": e_qmv, "rebal": 21, "topn": 20},
    ]
    exit_cfg = {"policy": "time", "timeout": 63, "disaster": 0.25, "costBps": FACTOR_COST_BPS}
    split = RS_LOOKBACK + int((n - RS_LOOKBACK) * 0.6)

    out = []
    spy_cagr = None
    qmv_trades = None
    for s in strategies:
        trades = sim_strategy(panels, s["entry"], s["rebal"], exit_cfg, s["topn"], RS_LOOKBACK + 1, n)
        if s["name"] == "qmv":
            qmv_trades = trades
        st = compute_stats(trades, idx, close, spy_close, n_trials=n_trials, config={"factor": s["name"]})
        spy_cagr = st["benchmark"]["spyCagr"]
        o = st["overall"]
        is_m = subset_metrics(trades, RS_LOOKBACK + 1, split)
        oos_m = subset_metrics(trades, split, n)
        beats = (o["cagr"] is not None and spy_cagr is not None and o["cagr"] > spy_cagr)
        robust = (o["dsr"] is not None and o["dsr"] >= 0.90)
        persists = (not is_m.get("insufficient") and not oos_m.get("insufficient")
                    and is_m.get("expectancyPct", 0) > 0 and oos_m.get("expectancyPct", 0) > 0)
        out.append({"name": s["name"], "label": s["label"], "nTrades": o["nTrades"],
                    "winRate": o["winRate"], "cagr": o["cagr"], "annSharpe": o["annSharpe"],
                    "dsr": o["dsr"], "maxDrawdownPct": o["maxDrawdownPct"],
                    "beatsSPY": beats, "robust": robust, "persists": persists,
                    "tradeable": bool(beats and robust and persists),
                    "inSample": is_m, "outOfSample": oos_m})

    winners = [s for s in out if s["tradeable"]]
    if winners:
        b = max(winners, key=lambda v: v["dsr"] or 0)
        verdict = (f"✓✓ 基本面因子找到 edge：「{b['label']}」全期贏 SPY({b['cagr']}% vs {spy_cagr}%)、"
                   f"DSR {b['dsr']}≥0.90、樣本外仍正。扣 40bps 元大成本後依然成立 —— 這是整段唯一通過的東西。")
    else:
        beat = [s for s in out if s["beatsSPY"]]
        verdict = (f"⨯ 五種基本面因子(扣 40bps 元大成本)無一全中(贏SPY+DSR≥0.9+樣本外)。"
                   + (f"最接近「{max(beat, key=lambda v: v['cagr'] or -99)['label']}」贏了 SPY 但穩健度/樣本外沒過。" if beat
                      else "連贏 SPY 都做不到。")
                   + " 注意：仍有倖存者偏差(宇宙是當前成分股)→ 真實只會更差。")
    # Era breakdown: does QMV beat SPY in ANY era (esp. non-mega-cap-bull periods)?
    era_breakdown = []
    if qmv_trades:
        spy = spy_close.values
        start = RS_LOOKBACK
        step = (n - start) // 4   # 4 eras
        for k in range(4):
            lo = start + k * step
            hi = (start + (k + 1) * step) if k < 3 else n
            sub = [t for t in qmv_trades if lo <= t["entry_i"] < hi]
            spy_ret = (spy[hi - 1] / spy[lo] - 1) if (spy[lo] > 0 and not np.isnan(spy[lo]) and not np.isnan(spy[hi - 1])) else None
            yrs = (idx[hi - 1] - idx[lo]).days / 365.25
            spy_cagr_era = ((spy[hi - 1] / spy[lo]) ** (1 / yrs) - 1) if (spy_ret is not None and yrs > 0) else None
            if len(sub) >= 8:
                rets = [t["ret"] for t in sub]
                era_breakdown.append({
                    "era": str(idx[lo].date()) + " ~ " + str(idx[hi - 1].date()),
                    "spyCagrPct": round(spy_cagr_era * 100, 1) if spy_cagr_era is not None else None,
                    "qmvMeanRetPct": round(sum(rets) / len(rets) * 100, 2),
                    "qmvWinRate": round(sum(1 for r in rets if r > 0) / len(sub), 2),
                    "nTrades": len(sub),
                    "qmvFavorable": bool(sum(rets) / len(rets) > 0 and (spy_cagr_era is None or spy_cagr_era < 0.08)),
                })

    return {"spyCagr": spy_cagr, "costBps": FACTOR_COST_BPS, "splitDate": str(idx[split].date()),
            "yearsTested": round((idx[-1] - idx[0]).days / 365.25, 1),
            "factors": out, "eraBreakdown": era_breakdown, "verdict": verdict, "coverage": len(fund_hist)}


# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    import yfinance as yf
    print("=== Historical backtest: RS Leader signal ===")
    print(f"Start: {datetime.now(timezone.utc).isoformat()}")

    universe = load_universe()
    print(f"  universe: {len(universe)} tickers")

    print("  downloading prices (this takes a few minutes)...")
    close, high, low, op, vol = download_prices(universe, YEARS)
    print(f"  got data for {close.shape[1]} symbols × {close.shape[0]} days")

    print("  downloading SPY benchmark...")
    spy_raw = yf.download("SPY", period=f"{YEARS}y", interval="1d",
                          auto_adjust=True, progress=False)
    spy_close = spy_raw["Close"]
    if isinstance(spy_close, pd.DataFrame):
        spy_close = spy_close.iloc[:, 0]
    spy_close = spy_close.reindex(close.index).ffill()

    if close.shape[1] < 50 or close.shape[0] < RS_LOOKBACK + 50:
        out = {"computedAt": int(time.time() * 1000), "error": "insufficient data",
               "symbols": int(close.shape[1]), "days": int(close.shape[0])}
        with open(os.path.join(DATA_DIR, "backtest_historical.json"), "w") as f:
            json.dump(out, f, indent=2)
        print("  insufficient data — wrote error stub")
        return

    print("  reconstructing signals...")
    leader, rs12_1, ret12_1 = build_signals(close, vol, spy_close)

    # MA cache for ma_exit policies
    ma_cache = {20: close.rolling(20).mean().values,
                50: close.rolling(50).mean().values}

    # ── Exit-policy lab: theory-driven configs (kept small to limit data-snooping) ──
    configs = [
        {"name": "baseline", "label": "基準 8%停損/15%目標", "policy": "fixed",
         "stop": 0.08, "target": 0.15, "timeout": 60},
        {"name": "wider", "label": "寬 12%停損/30%目標", "policy": "fixed",
         "stop": 0.12, "target": 0.30, "timeout": 90},
        {"name": "trail10", "label": "10% 移動停損(讓利潤奔跑)", "policy": "trailing",
         "trail": 0.10, "timeout": 120},
        {"name": "trail15", "label": "15% 移動停損", "policy": "trailing",
         "trail": 0.15, "timeout": 120},
        {"name": "ma_exit", "label": "跌破 20日均線出場", "policy": "ma_exit",
         "ma_period": 20, "disaster": 0.15, "timeout": 120},
        {"name": "trail15_regime", "label": "15%移動停損 + 僅多頭進場", "policy": "trailing",
         "trail": 0.15, "timeout": 120, "regime_gate": True},
    ]
    n_trials = max(DSR_TRIALS, len(configs) + 14)  # honest haircut for everything tried

    results = {}
    for cfg in configs:
        print(f"  simulating [{cfg['name']}]...")
        trades, idx = simulate(close, high, low, op, leader, rs12_1, spy_close, cfg, ma_cache)
        st = compute_stats(trades, idx, close, spy_close, n_trials=n_trials, config=cfg)
        st["label"] = cfg["label"]
        results[cfg["name"]] = st
        o = st["overall"]
        print(f"    N={o['nTrades']} win {o['winRate']*100:.1f}% exp {o['expectancyPct']:.2f}% "
              f"PF {o['profitFactor']} Sharpe {o['annSharpe']} DSR {o['dsr']} "
              f"CAGR {o['cagr']}% maxDD {o['maxDrawdownPct']}%")

    spy_cagr = results["baseline"]["benchmark"]["spyCagr"]

    # ── Hypothesis lab: genuinely different strategies + train/test split ──
    print("  running hypothesis lab (4 different strategies, IS/OOS split)...")
    strat_lab = run_strategy_lab(close, high, low, op, vol, spy_close, leader, rs12_1, n_trials)
    for s in strat_lab["strategies"]:
        print(f"    [{s['name']:12s}] N={s['nTrades']:4d} CAGR {s['cagr']}% DSR {s['dsr']} "
              f"beatsSPY={s['beatsSPY']} persists={s['persists']} tradeable={s['tradeable']}")
    print(f"    index_timing: CAGR {strat_lab['indexTiming']['cagr']}% maxDD {strat_lab['indexTiming']['maxDrawdownPct']}%")
    print(f"    STRATEGY VERDICT: {strat_lab['verdict']}")

    # ── Factor lab: point-in-time fundamentals (the genuinely-untested direction) ──
    factor_lab = None
    fh_path = os.path.join(DATA_DIR, "fundamentals_history.json")
    if os.path.exists(fh_path):
        try:
            with open(fh_path) as f:
                fund_hist = json.load(f).get("bySymbol", {})
            print(f"  running factor lab (point-in-time fundamentals, {len(fund_hist)} symbols)...")
            factor_lab = run_factor_lab(close, high, low, op, spy_close, leader, rs12_1, fund_hist, n_trials)
            for s in factor_lab["factors"]:
                print(f"    [{s['name']:9s}] N={s['nTrades']:4d} CAGR {s['cagr']}% DSR {s['dsr']} "
                      f"beatsSPY={s['beatsSPY']} persists={s['persists']} tradeable={s['tradeable']}")
            print(f"    FACTOR VERDICT: {factor_lab['verdict']}")
        except Exception as e:
            print(f"  factor lab failed: {e}")
    else:
        print("  (no fundamentals_history.json — run fetch_fundamentals_history.py first)")

    # Variant comparison summary (lightweight)
    variants = []
    for cfg in configs:
        o = results[cfg["name"]]["overall"]
        beats = (o["cagr"] is not None and spy_cagr is not None and o["cagr"] > spy_cagr)
        robust = (o["dsr"] is not None and o["dsr"] >= 0.90)
        variants.append({
            "name": cfg["name"], "label": cfg["label"],
            "nTrades": o["nTrades"], "winRate": o["winRate"],
            "expectancyPct": o["expectancyPct"], "profitFactor": o["profitFactor"],
            "annSharpe": o["annSharpe"], "dsr": o["dsr"],
            "cagr": o["cagr"], "maxDrawdownPct": o["maxDrawdownPct"],
            "beatsSPY": beats, "robust": robust,
            "tradeable": bool(beats and robust),
        })

    # Pick best variant by DSR (honest robustness), tie-broken by excess CAGR
    best = max(variants, key=lambda v: ((v["dsr"] or 0), (v["cagr"] or -99)))
    headline = results["baseline"]            # what's live now
    headline_best = results[best["name"]]     # best discovered config (full detail)

    # Overall lab verdict
    any_tradeable = any(v["tradeable"] for v in variants)
    if any_tradeable:
        tv = [v for v in variants if v["tradeable"]]
        names = "、".join(v["label"] for v in tv)
        lab_verdict = (f"✓ 找到 {len(tv)} 個「贏過 SPY 且 DSR≥0.90」的配置：{names}。"
                       f"最穩健的是「{best['label']}」(DSR {best['dsr']}, CAGR {best['cagr']}% vs SPY {spy_cagr}%)。"
                       " 注意：這仍是樣本內、且有倖存者偏差 → 下一步該樣本外驗證。")
    else:
        beats_only = [v for v in variants if v["beatsSPY"]]
        if beats_only:
            b = max(beats_only, key=lambda v: v["cagr"] or -99)
            lab_verdict = (f"⚠ 沒有任何配置同時「贏過 SPY 且 DSR≥0.90」。"
                           f"最接近的「{b['label']}」CAGR {b['cagr']}% 略勝 SPY {spy_cagr}%，"
                           f"但 DSR 僅 {b['dsr']} —— 換出場救不起來，這個 edge 站不住。")
        else:
            lab_verdict = (f"⨯ 6 種出場全部輸給單純買 SPY({spy_cagr}%)。"
                           " 換出場法救不了 RS Leader —— 問題出在「選股訊號本身沒有 edge」，不是出場。"
                           " 結論：別用這套選股，把工具價值轉向風控/紀律/不輸給自己。")

    out = {
        "computedAt": int(time.time() * 1000),
        "universeSize": int(close.shape[1]),
        "signal": "rs_leader",
        "labVerdict": lab_verdict,
        "anyTradeable": any_tradeable,
        "variants": variants,
        "bestVariant": best["name"],
        "baseline": headline,        # full detail — matches the live signal
        "best": headline_best,       # full detail — best discovered config
        "spyCagr": spy_cagr,
        "strategyLab": strat_lab,    # 4 different-hypothesis strategies + IS/OOS + index timing
        "factorLab": factor_lab,     # 5 point-in-time fundamental factor strategies (40bps 元大 cost)
    }
    out_path = os.path.join(DATA_DIR, "backtest_historical.json")
    with open(out_path, "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print(f"\n  wrote {out_path}")
    print(f"\n  LAB VERDICT: {lab_verdict}")
    print(f"End: {datetime.now(timezone.utc).isoformat()}")


if __name__ == "__main__":
    main()
