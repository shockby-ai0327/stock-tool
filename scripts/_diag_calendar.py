"""Probe yfinance calendar/earnings/eps_trend shapes for parsing."""
import yfinance as yf
import json
for sym in ['AAPL', 'NVDA', 'MU', 'IREN']:
    print(f"\n=== {sym} ===")
    t = yf.Ticker(sym)
    try:
        cal = t.calendar
        print(f"calendar type: {type(cal).__name__}")
        print(f"calendar: {cal!r}")
    except Exception as e:
        print(f"calendar FAILED: {e}")
    try:
        ed = t.get_earnings_dates(limit=4)
        print(f"get_earnings_dates type: {type(ed).__name__}")
        if hasattr(ed, 'head'):
            print(ed.head(3))
    except Exception as e:
        print(f"get_earnings_dates FAILED: {e}")
    try:
        et = t.eps_trend
        print(f"eps_trend type: {type(et).__name__}")
        if hasattr(et, 'head'):
            print(et.head())
        else:
            print(et)
    except Exception as e:
        print(f"eps_trend FAILED: {e}")
    try:
        er = t.eps_revisions
        print(f"eps_revisions type: {type(er).__name__}")
        if hasattr(er, 'head'):
            print(er.head())
        else:
            print(er)
    except Exception as e:
        print(f"eps_revisions FAILED: {e}")
