#!/usr/bin/env python3
"""
fetch_fundamentals_history.py — Point-in-time fundamental panel from SEC EDGAR.

WHY THIS EXISTS
---------------
The 5-round backtest only tested PRICE signals (momentum/reversion/breakout/PEAD)
— all crowded, all proved to have no edge over SPY. The factors with the most
robust academic premia are FUNDAMENTAL (value, quality, profitability), and we
literally could not test them because we had no point-in-time fundamentals
(current yfinance data = lookahead bias).

EDGAR XBRL is point-in-time for free: every fact carries a `filed` date, so at any
historical backtest date t we can use only what was actually known by t. This
fetcher pulls each company's full fact set once (companyfacts API) and extracts a
compact annual series for the concepts the factor backtest needs, preserving
filed-dates so the backtest stays honest (no lookahead).

Output: data/fundamentals_history.json
  { bySymbol: { TICKER: { netIncome:[[filed,end,val],...], revenue:[...],
                          equity:[...], opCashFlow:[...], capex:[...],
                          shares:[...] } } }

This unlocks the ONE combination we never honestly tested: quality × momentum ×
value, with a regime overlay and realistic costs.
"""

import json
import os
import sys
import time
from datetime import datetime, timezone

import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "..", "data")
SEC_UA = "stock-tool research/1.0 (contact: shockby-ai0327)"

# Concept → list of XBRL tag fallbacks (first that has data wins)
CONCEPTS = {
    "netIncome": ["NetIncomeLoss"],
    "revenue": ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet"],
    "equity": ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
    "opCashFlow": ["NetCashProvidedByUsedInOperatingActivities"],
    "capex": ["PaymentsToAcquirePropertyPlantAndEquipment"],
    "shares": ["CommonStockSharesOutstanding", "WeightedAverageNumberOfDilutedSharesOutstanding",
               "WeightedAverageNumberOfSharesOutstandingBasic"],
}


def load_json(name, fallback):
    try:
        with open(os.path.join(DATA_DIR, name)) as f:
            return json.load(f)
    except Exception:
        return fallback


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": SEC_UA, "Accept": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            if attempt == 2:
                return None
            time.sleep(1.5 * (attempt + 1))
    return None


def load_cik_map():
    cached = load_json("cik_map.json", None)
    if cached and cached.get("bySymbol"):
        return cached["bySymbol"]
    raw = fetch("https://www.sec.gov/files/company_tickers.json")
    by = {}
    if raw:
        for k in raw:
            e = raw[k]
            if e.get("ticker") and e.get("cik_str"):
                by[e["ticker"].upper()] = {"cik": str(e["cik_str"]).zfill(10), "title": e.get("title", "")}
        try:
            with open(os.path.join(DATA_DIR, "cik_map.json"), "w") as f:
                json.dump({"fetchedAt": int(time.time() * 1000), "bySymbol": by}, f)
        except Exception:
            pass
    return by


def extract_annual(facts, tags):
    """From companyfacts us-gaap facts, pull annual (FY/10-K) [filed, end, val] series."""
    usg = (facts or {}).get("facts", {}).get("us-gaap", {})
    for tag in tags:
        node = usg.get(tag)
        if not node:
            continue
        units = node.get("units", {})
        arr = units.get("USD") or units.get("shares") or next(iter(units.values()), [])
        out, seen = [], set()
        for x in arr:
            if x.get("form") == "10-K" and x.get("fp") == "FY" and x.get("val") is not None and x.get("filed"):
                key = x.get("fy")
                if key in seen:
                    continue
                seen.add(key)
                out.append([x["filed"], x.get("end", ""), x["val"]])
        if out:
            out.sort(key=lambda r: r[0])      # by filed date
            return out[-16:]                   # keep ~16 annual points (long-history test)
    return []


def main():
    print("=== EDGAR point-in-time fundamentals ===")
    print(f"Start: {datetime.now(timezone.utc).isoformat()}")

    uni = load_json("universe_static.json", None)
    tickers = (uni.get("tickers", []) if isinstance(uni, dict) else uni) or []
    tickers = [t for t in tickers if t and "." not in t and "/" not in t]
    cikmap = load_cik_map()
    print(f"  universe {len(tickers)} · cik map {len(cikmap)}")

    by_symbol = {}
    hits = 0
    for i, sym in enumerate(tickers):
        ent = cikmap.get(sym.upper())
        if not ent:
            continue
        facts = fetch(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{ent['cik']}.json")
        if not facts:
            continue
        rec = {}
        for name, tags in CONCEPTS.items():
            series = extract_annual(facts, tags)
            if series:
                rec[name] = series
        if rec.get("netIncome") and rec.get("equity"):
            by_symbol[sym] = rec
            hits += 1
        if (i + 1) % 50 == 0:
            sys.stdout.write(f"  {i+1}/{len(tickers)} · {hits} with data\r"); sys.stdout.flush()
        time.sleep(0.12)   # ~8 req/s, under SEC 10/s limit

    out = {"generatedAt": int(time.time() * 1000), "count": len(by_symbol), "bySymbol": by_symbol}
    path = os.path.join(DATA_DIR, "fundamentals_history.json")
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    sz = os.path.getsize(path) / 1e6
    print(f"\n  wrote {path}: {len(by_symbol)} symbols, {sz:.1f} MB")
    print(f"End: {datetime.now(timezone.utc).isoformat()}")


if __name__ == "__main__":
    main()
