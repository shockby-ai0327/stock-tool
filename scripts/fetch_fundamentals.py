#!/usr/bin/env python3
"""
fetch_fundamentals.py — Quality gate for the RS-Leader scanner.

WHY THIS EXISTS
---------------
The AI due-diligence run revealed that the scanner's top momentum names were ALL
cash-burning, unprofitable companies with expanding losses — the classic "momentum
trap" that the 5-round backtest proved blows up. The mechanical scanner ranks by
price strength alone; it is blind to whether the business actually makes money.

This adds the missing lens: for every leader + discovery, pull profitability /
cash-flow / growth from yfinance and assign a quality flag:
    quality : profitable AND free-cash-flow positive   (technically strong + sound)
    watch   : one of the two                            (mixed)
    trap    : neither — unprofitable AND burning cash   (momentum trap)

Writes data/fundamentals.json. The frontend uses it to badge each leader and warn
on traps, so the scanner stops surfacing fundamentally broken names without a flag.

This is the academically-supported "quality × momentum" combination (AQR's
quality-minus-junk + momentum) — the one synthesis the backtests pointed toward.
"""

import json
import os
import sys
import time
from datetime import datetime, timezone

# yfinance imported lazily in main() so assess() is unit-testable without it.
HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "..", "data")


def load_json(name, fallback):
    p = os.path.join(DATA_DIR, name)
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return fallback


def num(v):
    try:
        if v is None:
            return None
        f = float(v)
        return f if f == f else None   # drop NaN
    except (TypeError, ValueError):
        return None


def assess(info):
    """Return a quality dict from a yfinance .info dict (all fields defensive)."""
    net_income = num(info.get("netIncomeToCommon"))
    profit_margin = num(info.get("profitMargins"))
    op_margin = num(info.get("operatingMargins"))
    fcf = num(info.get("freeCashflow"))
    eps = num(info.get("trailingEps"))
    rev_growth = num(info.get("revenueGrowth"))
    earn_growth = num(info.get("earningsGrowth"))

    # profitable if any solid profit signal is positive
    profit_signals = [s for s in (net_income, profit_margin, eps) if s is not None]
    profitable = (len(profit_signals) > 0 and any(s > 0 for s in profit_signals)
                  and not (profit_margin is not None and profit_margin < 0)
                  and not (net_income is not None and net_income < 0))
    fcf_positive = (fcf is not None and fcf > 0)

    # quality score 0–100
    score = 0
    if profitable:
        score += 40
    if fcf_positive:
        score += 30
    if rev_growth is not None and rev_growth > 0:
        score += 15
    if op_margin is not None and op_margin > 0:
        score += 15

    # if we have essentially no fundamental data, don't accuse it of being a trap
    if len(profit_signals) == 0 and fcf is None and op_margin is None:
        flag = "unknown"
    elif profitable and fcf_positive:
        flag = "quality"
    elif profitable or fcf_positive:
        flag = "watch"
    else:
        flag = "trap"      # unprofitable AND cash-burning = momentum trap

    return {
        "flag": flag,
        "qualityScore": score,
        "profitable": profitable,
        "fcfPositive": fcf_positive,
        "profitMargin": round(profit_margin * 100, 1) if profit_margin is not None else None,
        "operatingMargin": round(op_margin * 100, 1) if op_margin is not None else None,
        "revenueGrowth": round(rev_growth * 100, 1) if rev_growth is not None else None,
        "earningsGrowth": round(earn_growth * 100, 1) if earn_growth is not None else None,
        "netIncomeM": round(net_income / 1e6, 0) if net_income is not None else None,
        "fcfM": round(fcf / 1e6, 0) if fcf is not None else None,
    }


def main():
    import yfinance as yf
    print("=== Fundamentals quality gate ===")
    scan = load_json("us_scan.json", None)
    if not scan or not scan.get("leaders"):
        print("No us_scan.json leaders — nothing to assess.")
        return

    symbols, seen = [], set()
    for s in (scan.get("leaders", []) + scan.get("discoveries", [])):
        sym = s.get("symbol")
        if sym and sym not in seen:
            seen.add(sym)
            symbols.append(sym)
    print(f"  assessing {len(symbols)} symbols")

    by_symbol = {}
    counts = {"quality": 0, "watch": 0, "trap": 0}
    for i, sym in enumerate(symbols):
        try:
            info = yf.Ticker(sym).info or {}
            q = assess(info)
            by_symbol[sym] = q
            counts[q["flag"]] = counts.get(q["flag"], 0) + 1
        except Exception as e:
            by_symbol[sym] = {"flag": "unknown", "qualityScore": None, "error": str(e)[:60]}
        if (i + 1) % 10 == 0:
            sys.stdout.write(f"  {i+1}/{len(symbols)}\r"); sys.stdout.flush()
        time.sleep(0.25)

    out = {
        "generatedAt": int(time.time() * 1000),
        "counts": counts,
        "bySymbol": by_symbol,
    }
    with open(os.path.join(DATA_DIR, "fundamentals.json"), "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print(f"\n  wrote fundamentals.json — quality {counts['quality']} · "
          f"watch {counts['watch']} · trap {counts['trap']}")
    print(f"End: {datetime.now(timezone.utc).isoformat()}")


if __name__ == "__main__":
    main()
