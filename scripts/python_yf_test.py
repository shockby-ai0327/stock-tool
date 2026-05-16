#!/usr/bin/env python3
"""Test if Python yfinance can punch through Yahoo's IP ban."""
import sys

try:
    import yfinance as yf
except ImportError:
    print("ERROR: yfinance not installed")
    sys.exit(1)

print(f"yfinance version: {yf.__version__}")

# Test 1: Direct download
print("\n=== Test 1: yf.download('SPY', period='1mo') ===")
try:
    df = yf.download('SPY', period='1mo', progress=False)
    print(f"Got {len(df)} rows")
    if len(df) > 0:
        print(df.tail(3).to_string())
except Exception as e:
    print(f"FAILED: {e}")

# Test 2: Ticker.history
print("\n=== Test 2: yf.Ticker('SPY').history(period='1mo') ===")
try:
    t = yf.Ticker('SPY')
    df = t.history(period='1mo')
    print(f"Got {len(df)} rows")
    if len(df) > 0:
        print(f"Last close: {df['Close'].iloc[-1]:.2f}")
except Exception as e:
    print(f"FAILED: {e}")

# Test 3: Multi-ticker download
print("\n=== Test 3: yf.download(['SPY','AAPL','NVDA'], period='5d') ===")
try:
    df = yf.download(['SPY','AAPL','NVDA'], period='5d', progress=False, group_by='ticker')
    print(f"Got {len(df)} rows, columns: {list(df.columns)[:6]}")
except Exception as e:
    print(f"FAILED: {e}")
