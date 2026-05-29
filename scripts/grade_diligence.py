#!/usr/bin/env python3
"""
grade_diligence.py — Honest forward-tracker / self-grader for AI due-diligence.

WHY THIS EXISTS
---------------
A research process is only an *edge* if it actually works going forward. This is
the machine that turns the AI analyst's calls into evidence: it reads every past
thesis from ai_diligence.json's history, and measures — honestly — how each name
performed SINCE the analysis date, vs simply holding SPY over the same window.

Then it answers the only question that matters:
    Does the AI's conviction (1-5) actually predict subsequent alpha?
If high-conviction names beat SPY and low-conviction ones don't → the process has
signal. If conviction is uncorrelated with outcome → it's theatre, and we'll know.

Writes data/diligence_scorecard.json. Accumulates value over weeks/months as the
history grows (today it's near-zero because the history just started — that's fine,
this is the machinery that makes the verdict possible later).
"""

import json
import os
import sys
import time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "..", "data")


def load_json(name, fallback):
    try:
        with open(os.path.join(DATA_DIR, name)) as f:
            return json.load(f)
    except Exception:
        return fallback


def main():
    import yfinance as yf
    import pandas as pd
    print("=== Due-diligence forward-tracker ===")

    dil = load_json("ai_diligence.json", None)
    hist = (dil or {}).get("history", [])
    # only entries with a recorded entry price are gradeable
    gradeable = [h for h in hist if h.get("priceAtAnalysis") and h.get("symbol") and h.get("date")]
    if not gradeable:
        print("  no gradeable history yet — writing empty scorecard")
        with open(os.path.join(DATA_DIR, "diligence_scorecard.json"), "w") as f:
            json.dump({"generatedAt": int(time.time() * 1000), "graded": 0,
                       "note": "歷史剛起步,尚無可評分的前向資料"}, f, ensure_ascii=False, indent=2)
        return

    symbols = sorted(set(h["symbol"] for h in gradeable))
    print(f"  grading {len(gradeable)} theses across {len(symbols)} symbols")

    # download enough history to cover the earliest analysis date
    earliest = min(h["date"] for h in gradeable)
    try:
        px = yf.download(symbols + ["SPY"], start=earliest, interval="1d",
                         auto_adjust=True, progress=False, threads=True)["Close"]
        if isinstance(px, pd.Series):
            px = px.to_frame()
    except Exception as e:
        print(f"  download failed: {e}")
        return

    def price_on_or_after(sym, date_str):
        if sym not in px.columns:
            return None
        s = px[sym].dropna()
        s = s[s.index >= pd.Timestamp(date_str)]
        return float(s.iloc[0]) if len(s) else None

    def latest(sym):
        if sym not in px.columns:
            return None
        s = px[sym].dropna()
        return float(s.iloc[-1]) if len(s) else None

    graded = []
    for h in gradeable:
        sym = h["symbol"]
        entry = h["priceAtAnalysis"]
        cur = latest(sym)
        spy0 = price_on_or_after("SPY", h["date"])
        spy1 = latest("SPY")
        if not (cur and entry and spy0 and spy1):
            continue
        ret = cur / entry - 1
        spy_ret = spy1 / spy0 - 1
        days = (datetime.now(timezone.utc).date() - datetime.fromisoformat(h["date"]).date()).days
        graded.append({"symbol": sym, "date": h["date"], "conviction": h.get("conviction"),
                       "daysHeld": days, "retPct": round(ret * 100, 1),
                       "spyRetPct": round(spy_ret * 100, 1), "alphaPct": round((ret - spy_ret) * 100, 1)})

    # aggregate by conviction bucket
    by_conv = {}
    for g in graded:
        c = g["conviction"]
        if c is None:
            continue
        by_conv.setdefault(c, []).append(g)
    conv_summary = []
    for c in sorted(by_conv):
        arr = by_conv[c]
        alphas = [g["alphaPct"] for g in arr]
        conv_summary.append({"conviction": c, "n": len(arr),
                             "avgAlphaPct": round(sum(alphas) / len(alphas), 1),
                             "winVsSpy": round(sum(1 for a in alphas if a > 0) / len(arr), 2)})

    # does conviction predict alpha? (compare high 4-5 vs low 1-2)
    hi = [g["alphaPct"] for g in graded if (g["conviction"] or 0) >= 4]
    lo = [g["alphaPct"] for g in graded if (g["conviction"] or 0) <= 2]
    signal = None
    if len(hi) >= 5 and len(lo) >= 5:
        hi_avg = sum(hi) / len(hi); lo_avg = sum(lo) / len(lo)
        signal = {"highConvAvgAlpha": round(hi_avg, 1), "lowConvAvgAlpha": round(lo_avg, 1),
                  "convictionPredicts": hi_avg > lo_avg + 2}  # >2% spread = meaningful

    overall_alpha = round(sum(g["alphaPct"] for g in graded) / len(graded), 1) if graded else None
    median_days = sorted(g["daysHeld"] for g in graded)[len(graded) // 2] if graded else 0

    if median_days < 21:
        verdict = f"歷史僅 {median_days} 天(中位),太早下結論。需累積 1-3 個月前向資料。"
    elif signal is None:
        verdict = f"已評 {len(graded)} 筆,平均 alpha {overall_alpha}% vs SPY。樣本仍不足以判斷信心是否預測表現。"
    elif signal["convictionPredicts"]:
        verdict = (f"✓ 信心有預測力:高信心(4-5)平均 alpha {signal['highConvAvgAlpha']}% "
                   f"vs 低信心(1-2){signal['lowConvAvgAlpha']}%。AI 研究流程開始顯示 signal。")
    else:
        verdict = (f"⨯ 信心無預測力:高信心 alpha {signal['highConvAvgAlpha']}% "
                   f"≈ 低信心 {signal['lowConvAvgAlpha']}%。研究流程目前是 theatre,不是 edge。")

    out = {"generatedAt": int(time.time() * 1000), "graded": len(graded),
           "overallAlphaPct": overall_alpha, "medianDaysHeld": median_days,
           "byConviction": conv_summary, "convictionSignal": signal,
           "trades": sorted(graded, key=lambda g: -(g["alphaPct"])), "verdict": verdict}
    with open(os.path.join(DATA_DIR, "diligence_scorecard.json"), "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"  graded {len(graded)} · overall alpha {overall_alpha}% · {verdict}")
    print(f"End: {datetime.now(timezone.utc).isoformat()}")


if __name__ == "__main__":
    main()
