#!/usr/bin/env python3
"""
fetch_spy_history.py — daily SPY closes for the "my trades vs SPY" scorecard (B1).

The forward-tracker needs SPY's price on each of the user's trade dates to compute
whether THEIR real decisions beat just holding the index. Yahoo blocks browser
chart calls, so we pre-fetch SPY daily history here (yfinance) and commit a small
JSON the frontend reads. ~6 years is plenty for any realistic trade history.

Output: data/spy_history.json = { "dates": ["2020-06-08", ...], "closes": [...] }
"""

import json
import os
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "..", "data")


def main():
    import yfinance as yf
    print("=== SPY daily history (for my-edge scorecard) ===")
    try:
        df = yf.download("SPY", period="6y", interval="1d", auto_adjust=True, progress=False)
    except Exception as e:
        print(f"  download failed: {e}"); sys.exit(0)
    close = df["Close"]
    try:
        import pandas as pd
        if isinstance(close, pd.DataFrame):
            close = close.iloc[:, 0]
    except Exception:
        pass
    close = close.dropna()
    out = {
        "generatedAt": int(datetime.now(timezone.utc).timestamp() * 1000),
        "dates": [d.strftime("%Y-%m-%d") for d in close.index],
        "closes": [round(float(v), 2) for v in close.values],
    }
    path = os.path.join(DATA_DIR, "spy_history.json")
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"  wrote spy_history.json: {len(out['dates'])} days "
          f"({out['dates'][0]} → {out['dates'][-1]})")


if __name__ == "__main__":
    main()
