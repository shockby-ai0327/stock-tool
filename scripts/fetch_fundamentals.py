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
        if f != f or f in (float("inf"), float("-inf")):
            return None   # drop NaN AND ±Infinity — Python json 寫得出 Infinity,但瀏覽器 JSON.parse 會炸全檔
        return f
    except (TypeError, ValueError):
        return None


def trim_summary(s):
    """First 1–2 sentences of the business summary, capped — enough to know what the company does."""
    if not s:
        return None
    import re
    s = " ".join(str(s).split())
    parts = re.split(r"(?<=[.])\s+", s)
    out = parts[0] if parts else s
    if len(out) < 90 and len(parts) > 1:
        out = out + " " + parts[1]
    out = out[:220].rstrip()
    return out or None


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

    # 2026-06-09 基本面深度:估值 / 財務體質 / 規模 / 獲利效率(全部來自 yfinance .info,免費)。
    # 用途是「動能標的的真實性檢查」(真公司 vs 燒錢/迷因),不是價值選股。
    def pct1(x):
        return round(x * 100, 1) if x is not None else None

    def r(x, n=1):
        return round(x, n) if x is not None else None

    def mil(x):
        return round(x / 1e6, 0) if x is not None else None

    gross_margin = num(info.get("grossMargins"))
    roe = num(info.get("returnOnEquity"))
    roa = num(info.get("returnOnAssets"))
    eq_growth = num(info.get("earningsQuarterlyGrowth"))
    div_yield = num(info.get("dividendYield"))

    return {
        "flag": flag,
        "qualityScore": score,
        "profitable": profitable,
        "fcfPositive": fcf_positive,
        # 獲利能力
        "profitMargin": pct1(profit_margin),
        "operatingMargin": pct1(op_margin),
        "grossMargin": pct1(gross_margin),
        "roe": pct1(roe),
        "roa": pct1(roa),
        # 成長
        "revenueGrowth": pct1(rev_growth),
        "earningsGrowth": pct1(earn_growth),
        "earningsQGrowth": pct1(eq_growth),
        # 規模 / 絕對數字
        "netIncomeM": mil(net_income),
        "fcfM": mil(fcf),
        "revenueM": mil(num(info.get("totalRevenue"))),
        "marketCapM": mil(num(info.get("marketCap"))),
        # 估值
        "trailingPE": r(num(info.get("trailingPE"))),
        "forwardPE": r(num(info.get("forwardPE"))),
        "priceToSales": r(num(info.get("priceToSalesTrailing12Months"))),
        "priceToBook": r(num(info.get("priceToBook"))),
        "peg": r(num(info.get("pegRatio")), 2),
        "evToEbitda": r(num(info.get("enterpriseToEbitda"))),
        # 財務體質
        "debtToEquity": r(num(info.get("debtToEquity"))),
        "currentRatio": r(num(info.get("currentRatio")), 2),
        "totalCashM": mil(num(info.get("totalCash"))),
        "totalDebtM": mil(num(info.get("totalDebt"))),
        "dividendYield": pct1(div_yield),
        # 分類 + 業務(做什麼的)
        "sector": info.get("sector") or None,
        "industry": info.get("industry") or None,
        "summary": trim_summary(info.get("longBusinessSummary")),
    }


def _leader_symbols():
    scan = load_json("us_scan.json", None) or {}
    symbols, seen = [], set()
    for s in (scan.get("leaders", []) + scan.get("discoveries", [])):
        sym = s.get("symbol")
        if sym and sym not in seen and "." not in sym:
            seen.add(sym)
            symbols.append(sym)
    return symbols


def _universe_symbols():
    """Leaders first (freshest priority), then the full ~1200-name scan universe."""
    symbols = _leader_symbols()
    seen = set(symbols)
    static = load_json("universe_static.json", {}) or {}
    for sym in (static.get("tickers") or []):
        if sym and sym not in seen and "." not in sym:
            seen.add(sym)
            symbols.append(sym)
    return symbols


def _write(by_symbol):
    counts = {"quality": 0, "watch": 0, "trap": 0, "unknown": 0}
    for q in by_symbol.values():
        counts[q.get("flag", "unknown")] = counts.get(q.get("flag", "unknown"), 0) + 1
    out = {
        "generatedAt": int(time.time() * 1000),
        "counts": counts,
        "bySymbol": by_symbol,
    }
    # compact:universe 模式下 1200+ 檔,indent=2 會讓檔案翻倍(~2MB);前端不在乎排版
    # allow_nan=False:任何 NaN/Infinity 漏網就在 CI 大聲炸,而不是寫出瀏覽器讀不了的檔
    with open(os.path.join(DATA_DIR, "fundamentals.json"), "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return counts


def main():
    # 2026-06-10:--universe 全掃描池(~1200 檔,每日 cron),預設 = 排行榜 leaders(一天 3 次)。
    # 兩種模式都「合併寫入」同一個 fundamentals.json:更新自己負責的符號、保留其他人的,
    # 所以 3 次/日的 leaders 刷新不會把 universe 的廣覆蓋蓋掉,反之亦然。
    universe_mode = "--universe" in sys.argv
    limit = None
    if "--limit" in sys.argv:
        try:
            limit = int(sys.argv[sys.argv.index("--limit") + 1])
        except (IndexError, ValueError):
            pass
    FRESH_DAYS = 2  # universe 模式:2 天內抓過的跳過(基本面變化以「天」計,省 API + 可斷點續跑)

    import yfinance as yf
    print(f"=== Fundamentals quality gate ({'universe' if universe_mode else 'leaders'}) ===")

    existing = load_json("fundamentals.json", {}) or {}
    by_symbol = dict(existing.get("bySymbol") or {})

    targets = _universe_symbols() if universe_mode else _leader_symbols()
    if not targets:
        print("  no symbols to assess — nothing to do.")
        return
    if universe_mode:
        # 修剪:已不在 universe ∪ leaders 的舊符號移除,檔案不無限長大
        keep = set(targets)
        by_symbol = {s: q for s, q in by_symbol.items() if s in keep}

    now_ms = int(time.time() * 1000)
    todo = []
    for sym in targets:
        prev = by_symbol.get(sym)
        if universe_mode and prev and prev.get("asOf") and (now_ms - prev["asOf"]) < FRESH_DAYS * 86400_000 and prev.get("flag") != "unknown":
            continue  # 還新鮮,跳過(leaders 模式永遠重抓,保持一天 3 次新鮮)
        todo.append(sym)
    if limit:
        todo = todo[:limit]
    print(f"  targets {len(targets)} · to fetch {len(todo)} (rest fresh ≤{FRESH_DAYS}d)")

    fetched = 0
    for i, sym in enumerate(todo):
        try:
            info = yf.Ticker(sym).info or {}
            q = assess(info)
            q["asOf"] = int(time.time() * 1000)
            by_symbol[sym] = q
            fetched += 1
        except Exception as e:
            # 抓失敗:保留舊資料(若有),沒有才寫 unknown — 別用失敗覆蓋好資料
            if sym not in by_symbol:
                by_symbol[sym] = {"flag": "unknown", "qualityScore": None, "error": str(e)[:60], "asOf": int(time.time() * 1000)}
        if (i + 1) % 10 == 0:
            sys.stdout.write(f"  {i+1}/{len(todo)}\r"); sys.stdout.flush()
        # checkpoint:每 100 檔落盤一次 — 長跑被砍也保留進度(寫入是合併式,安全)
        if (i + 1) % 100 == 0:
            _write(by_symbol)
        time.sleep(0.25)

    counts = _write(by_symbol)
    print(f"\n  wrote fundamentals.json — {len(by_symbol)} symbols (fetched {fetched}) · "
          f"quality {counts['quality']} · watch {counts['watch']} · trap {counts['trap']} · unknown {counts.get('unknown', 0)}")
    print(f"End: {datetime.now(timezone.utc).isoformat()}")


if __name__ == "__main__":
    main()
