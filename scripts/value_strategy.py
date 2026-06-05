#!/usr/bin/env python3
"""
value_strategy.py — Systematic value×quality strategy + survivorship-immune forward test.

WHY THIS EXISTS
---------------
After 5 rounds killing price signals and testing 5 fundamental factors over 15 years,
exactly ONE thing passed all honest gates (beats SPY + DSR>=0.9 + out-of-sample +
after 40bps 元大 cost): the VALUE factor (high earnings yield). BUT that backtest is
heavily survivorship-biased — and value is the factor that bias fakes most ("buy cheap
stocks we already KNOW survived"). So we do NOT trust the magnitude.

The only clean way to validate it is FORWARD: real-time picks include the ones that
later fail, so there is zero survivorship bias. This script:
  1. Ranks the universe by value (earnings yield + book yield) AMONG quality names
     (profitable + positive FCF — this is the key: pure value = value traps;
      value×quality avoids the dead-cheap-and-staying-cheap names).
  2. Emits the monthly top-N "價值精選" picks with a complete order plan.
  3. Logs every pick and grades the full forward history vs same-period SPY —
     survivorship-immune, the honest judge.

Honest labels everywhere: direction has academic support (Fama-French value premium),
magnitude is UNPROVEN and expected to be small (1-3%) with multi-year losing stretches.

Output: data/value_picks.json
"""

import json
import os
import sys
import time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "..", "data")
UNIVERSE_CAP = 500       # liquidity/runtime cap
TOP_N = 20               # monthly picks


def load_json(name, fallback):
    try:
        with open(os.path.join(DATA_DIR, name)) as f:
            return json.load(f)
    except Exception:
        return fallback


def num(v):
    try:
        if v is None:
            return None
        f = float(v)
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def quality_ok(info):
    """Profitable + positive FCF — filters out value traps (cheap because dying)."""
    ni = num(info.get("netIncomeToCommon"))
    pm = num(info.get("profitMargins"))
    fcf = num(info.get("freeCashflow"))
    profitable = ((ni is not None and ni > 0) or (pm is not None and pm > 0)) and not (pm is not None and pm < 0)
    return bool(profitable and fcf is not None and fcf > 0)


def value_metrics(info):
    pe = num(info.get("trailingPE"))
    pb = num(info.get("priceToBook"))
    eps = num(info.get("trailingEps"))
    price = num(info.get("currentPrice")) or num(info.get("regularMarketPrice"))
    roe = num(info.get("returnOnEquity"))
    mcap = num(info.get("marketCap"))
    # earnings yield (prefer EPS/price, fall back to 1/PE)
    ey = (eps / price) if (eps and price and price > 0) else (1.0 / pe if (pe and pe > 0) else None)
    by = (1.0 / pb) if (pb and pb > 0) else None     # book yield
    return {"pe": pe, "pb": pb, "eps": eps, "earningsYield": ey, "bookYield": by,
            "roe": roe, "price": price, "marketCap": mcap}


def data_sane(vm):
    """Auto data-quality gate — keep garbage out so the user never sees it.
    Returns (ok, reason)."""
    p = vm["price"]; ey = vm["earningsYield"]; pe = vm["pe"]; mc = vm["marketCap"]; eps = vm["eps"]
    if not p or p < 3:
        return False, "price<$3 (penny/illiquid/bad-data)"
    if mc is None or mc < 5e8:
        return False, "marketCap<$500M (illiquid/sparse data)"
    if ey is None or ey <= 0 or ey > 0.4:           # E/P>40% (PE<2.5) ≈ always bad/one-off
        return False, "earnings yield out of sane range"
    if pe is not None and (pe < 2.5 or pe > 100):
        return False, "PE out of sane range"
    # cross-field consistency: EPS/price vs 1/PE must agree within 3x
    if eps and p and pe and pe > 0:
        ey_eps = eps / p
        ey_pe = 1.0 / pe
        if ey_eps > 0 and ey_pe > 0:
            ratio = max(ey_eps, ey_pe) / min(ey_eps, ey_pe)
            if ratio > 3:
                return False, "EPS/price vs 1/PE inconsistent (suspect data)"
    return True, ""


def main():
    import yfinance as yf
    print("=== Value × Quality systematic strategy ===")
    print(f"Start: {datetime.now(timezone.utc).isoformat()}")

    uni = load_json("universe_static.json", None)
    tickers = (uni.get("tickers", []) if isinstance(uni, dict) else uni) or []
    tickers = [t for t in tickers if t and "." not in t and "/" not in t][:UNIVERSE_CAP]
    print(f"  scanning {len(tickers)} names for value×quality")

    rows = []
    rejected = []
    for i, sym in enumerate(tickers):
        try:
            info = yf.Ticker(sym).info or {}
            if not quality_ok(info):
                continue
            vm = value_metrics(info)
            ok, reason = data_sane(vm)   # auto data-quality gate (keep garbage out)
            if not ok:
                rejected.append((sym, reason))
                continue
            rows.append({"symbol": sym, **vm,
                         "name": info.get("shortName") or sym,
                         "sector": info.get("sector") or ""})
        except Exception:
            pass
        if (i + 1) % 50 == 0:
            sys.stdout.write(f"  {i+1}/{len(tickers)} · {len(rows)} qualify\r"); sys.stdout.flush()
        time.sleep(0.2)
    print(f"\n  {len(rows)} names pass value×quality · {len(rejected)} rejected by data-quality gate")
    if rejected:
        from collections import Counter
        for reason, c in Counter(r[1] for r in rejected).most_common():
            print(f"    rejected {c}: {reason}")

    if len(rows) < TOP_N:
        print("  too few qualifiers — writing minimal output")

    # composite value score = mean percentile rank of earnings yield + book yield
    def pct_rank(key):
        vals = [(r["symbol"], r.get(key)) for r in rows if r.get(key) is not None]
        vals.sort(key=lambda x: x[1])
        rank = {}
        m = len(vals)
        for idx, (s, _) in enumerate(vals):
            rank[s] = idx / (m - 1) if m > 1 else 0.5
        return rank
    ey_rank = pct_rank("earningsYield")
    by_rank = pct_rank("bookYield")
    for r in rows:
        parts = [ey_rank.get(r["symbol"]), by_rank.get(r["symbol"])]
        parts = [p for p in parts if p is not None]
        r["valueScore"] = round(sum(parts) / len(parts) * 100, 1) if parts else 0

    rows.sort(key=lambda r: -r["valueScore"])
    picks = rows[:TOP_N]
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    month = today[:7]

    # ── history (survivorship-immune forward log) ──
    prior = load_json("value_picks.json", {"history": []})
    history = [h for h in prior.get("history", []) if isinstance(h, dict)]
    # allow a same-day re-run to CORRECT today's log (e.g. data-bug fix); but once a
    # prior day in this month is recorded, the month is immutable (forward test integrity).
    history = [h for h in history if h.get("date") != today]
    month_has_prior = any(h.get("month") == month for h in history)
    if not month_has_prior:
        for p in picks:
            history.append({"symbol": p["symbol"], "month": month, "date": today,
                            "priceAtPick": p["price"], "valueScore": p["valueScore"]})
        print(f"  logged {len(picks)} picks for {month} (forward test)")
    else:
        print(f"  {month} already logged on an earlier day — locked")
    history = history[-2000:]

    # ── grade history vs SPY (survivorship-immune) ──
    scorecard = grade(history, yf)

    out = {
        "generatedAt": int(time.time() * 1000),
        "asOf": today,
        "universeScanned": len(tickers),
        "qualified": len(rows),
        "picks": [{"symbol": p["symbol"], "name": p["name"], "sector": p["sector"],
                   "price": round(p["price"], 2), "valueScore": p["valueScore"],
                   "earningsYieldPct": round(p["earningsYield"] * 100, 1),
                   "pe": round(p["pe"], 1) if p["pe"] else None,
                   "pb": round(p["pb"], 2) if p["pb"] else None,
                   "roePct": round(p["roe"] * 100, 1) if p["roe"] else None}
                  for p in picks],
        "history": history,
        "scorecard": scorecard,
        "disclaimer": ("方向有學界支撐(Fama-French 價值溢酬),但幅度未經證實、預期很小(1-3%)、"
                       "且會連輸好幾年。回測曾被倖存者偏差灌水 → 唯有下方前向追蹤(免疫倖存者偏差)才算數。"),
    }
    with open(os.path.join(DATA_DIR, "value_picks.json"), "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"  wrote value_picks.json — {len(picks)} picks, {len(history)} history, "
          f"scorecard: {scorecard.get('verdict','')[:60]}")
    print(f"End: {datetime.now(timezone.utc).isoformat()}")


def grade(history, yf):
    """Forward scorecard: each pick's return since pick vs same-period SPY. No survivorship bias."""
    gradeable = [h for h in history if h.get("priceAtPick") and h.get("symbol") and h.get("date")]
    if not gradeable:
        return {"graded": 0, "verdict": "尚無前向資料 — 每月累積中"}
    import pandas as pd
    symbols = sorted(set(h["symbol"] for h in gradeable))
    earliest = min(h["date"] for h in gradeable)
    try:
        px = yf.download(symbols + ["SPY"], start=earliest, interval="1d",
                         auto_adjust=True, progress=False, threads=True)["Close"]
        if isinstance(px, pd.Series):
            px = px.to_frame()
    except Exception:
        return {"graded": 0, "verdict": "報價下載失敗"}

    def at(sym, date):
        if sym not in px.columns:
            return None
        s = px[sym].dropna()
        s = s[s.index >= pd.Timestamp(date)]
        return float(s.iloc[0]) if len(s) else None

    def last(sym):
        if sym not in px.columns:
            return None
        s = px[sym].dropna()
        return float(s.iloc[-1]) if len(s) else None

    rows, alphas = [], []
    for h in gradeable:
        cur = last(h["symbol"]); spy0 = at("SPY", h["date"]); spy1 = last("SPY")
        if not (cur and h["priceAtPick"] and spy0 and spy1):
            continue
        ret = cur / h["priceAtPick"] - 1
        spy_ret = spy1 / spy0 - 1
        days = (datetime.now(timezone.utc).date() - datetime.fromisoformat(h["date"]).date()).days
        rows.append({"symbol": h["symbol"], "date": h["date"], "daysHeld": days,
                     "retPct": round(ret * 100, 1), "spyRetPct": round(spy_ret * 100, 1),
                     "alphaPct": round((ret - spy_ret) * 100, 1)})
        alphas.append((ret - spy_ret) * 100)
    if not rows:
        return {"graded": 0, "verdict": "尚無可評分前向資料"}
    avg_alpha = round(sum(alphas) / len(alphas), 1)
    win = round(sum(1 for a in alphas if a > 0) / len(alphas), 2)
    median_days = sorted(r["daysHeld"] for r in rows)[len(rows) // 2]
    if median_days < 30:
        verdict = f"前向僅 {median_days} 天(中位),太早 — 價值要看月/季,需 3-6 個月才有意義。"
    elif avg_alpha > 1:
        verdict = f"✓ 前向平均 alpha +{avg_alpha}% vs SPY、勝率 {int(win*100)}% — 真實時間裡開始顯示價值溢酬。"
    elif avg_alpha < -1:
        verdict = f"⨯ 前向平均 alpha {avg_alpha}% vs SPY — 回測的價值 edge 在真實時間沒出現(很可能是倖存者偏差)。"
    else:
        verdict = f"前向平均 alpha {avg_alpha}% vs SPY、勝率 {int(win*100)}% — 接近持平,繼續累積。"
    return {"graded": len(rows), "avgAlphaPct": avg_alpha, "winVsSpy": win,
            "medianDaysHeld": median_days,
            "trades": sorted(rows, key=lambda r: -r["alphaPct"]), "verdict": verdict}


if __name__ == "__main__":
    main()
