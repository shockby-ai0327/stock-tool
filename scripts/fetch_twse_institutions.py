#!/usr/bin/env python3
"""
fetch_twse_institutions.py — 三大法人買賣超 daily snapshot from TWSE/TPEx.

Pulls today's 外資/投信/自營商 net buy-sell for each ticker via TWSE's
free public API:
  https://www.twse.com.tw/fund/T86?response=json&date=YYYYMMDD&selectType=ALL

Output: data/tw_institutions.json
{
  generatedAt, tradeDate, bySymbol: {
    "2330": {
      foreign:    1234567,    # 外資+陸資 (shares)
      foreignAmt: 678901234,  # 外資成交金額 (NT$)
      investment_trust: ...,  # 投信
      dealer:           ...,  # 自營商
      total:            ...,  # 三大法人合計
      conviction:  'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell'
    }
  }
}
"""
import urllib.request
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / 'data'
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / 'tw_institutions.json'

# TWSE 三大法人買賣超日報 endpoint
TWSE_T86 = 'https://www.twse.com.tw/fund/T86?response=json&date={date}&selectType=ALL'
# TPEx (櫃買中心) — different endpoint
TPEX_T86 = 'https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_print.php?l=zh-tw&d={date_roc}&s=0,asc,0'

def fetch_json(url):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json,*/*',
        'Accept-Language': 'zh-TW,zh;q=0.9',
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode('utf-8'))
    except Exception as e:
        print(f'  fetch failed {url[:60]}...: {e}')
        return None

def get_latest_trading_day():
    """TWSE updates around 17:30 Taipei time. If we run before that, use prev day."""
    now = datetime.now(timezone(timedelta(hours=8)))
    # If we're between 0:00 and 17:30 Taipei, today's data may not be ready
    if now.hour < 17 or (now.hour == 17 and now.minute < 30):
        # Walk back to find a weekday
        d = now - timedelta(days=1)
    else:
        d = now
    # Skip Sat/Sun
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d.strftime('%Y%m%d')

def parse_twse(data):
    """TWSE T86 response: {fields:[...], data:[[...]], date: 'YYYYMMDD'}"""
    if not data or 'data' not in data or 'fields' not in data:
        return {}
    fields = data['fields']
    # Find column indices — TWSE field names may vary
    idx = {}
    for i, f in enumerate(fields):
        f_clean = f.replace(' ', '').replace('　', '')
        if '證券代號' in f_clean or '股票代號' in f_clean:    idx['symbol'] = i
        if '證券名稱' in f_clean or '股票名稱' in f_clean:    idx['name'] = i
        # 外資買賣超股數 (combined)
        if '外陸資買賣超股數' in f_clean or '外資買賣超股數' in f_clean: idx['foreign'] = i
        # Investment trust
        if '投信買賣超股數' in f_clean: idx['it'] = i
        # Dealer (self + hedge combined)
        if '自營商買賣超股數(合計)' in f_clean or '自營商買賣超股數' in f_clean: idx['dealer'] = i
        if '三大法人買賣超股數' in f_clean: idx['total'] = i

    if 'symbol' not in idx:
        return {}

    bySymbol = {}
    nameMap = {}
    for row in data['data']:
        try:
            sym = row[idx['symbol']].strip()
            # Pure-numeric Taiwan tickers (e.g. 2330, 2317). Skip warrants etc.
            if not sym.isdigit() or len(sym) != 4:
                continue
            # 同時抓 Chinese name (證券名稱) — TWSE 提供繁體中文公司名
            if 'name' in idx:
                cname = row[idx['name']].strip()
                if cname: nameMap[sym] = cname
            def _to_int(s):
                try: return int(str(s).replace(',', '').strip())
                except: return 0
            foreign = _to_int(row[idx['foreign']]) if 'foreign' in idx else 0
            it      = _to_int(row[idx['it']])      if 'it'      in idx else 0
            dealer  = _to_int(row[idx['dealer']])  if 'dealer'  in idx else 0
            total   = _to_int(row[idx['total']])   if 'total'   in idx else (foreign + it + dealer)
            # Conviction: classify based on total + sign distribution
            n_pos = sum(1 for x in [foreign, it, dealer] if x > 0)
            n_neg = sum(1 for x in [foreign, it, dealer] if x < 0)
            if total > 500000 and n_pos >= 2:
                conv = 'strong_buy'
            elif total > 100000:
                conv = 'buy'
            elif total < -500000 and n_neg >= 2:
                conv = 'strong_sell'
            elif total < -100000:
                conv = 'sell'
            else:
                conv = 'neutral'
            bySymbol[sym] = {
                'foreign':         foreign,
                'investmentTrust': it,
                'dealer':          dealer,
                'total':           total,
                'conviction':      conv,
            }
        except Exception:
            continue
    # Attach nameMap to result via closure trick
    bySymbol['__nameMap__'] = nameMap
    return bySymbol

def main():
    date_str = get_latest_trading_day()
    print(f'Fetching TWSE 三大法人買賣超 for {date_str}')

    twse_data = fetch_json(TWSE_T86.format(date=date_str))
    by_symbol = parse_twse(twse_data)

    if not by_symbol:
        # Try yesterday if today wasn't ready
        prev = (datetime.strptime(date_str, '%Y%m%d') - timedelta(days=1))
        while prev.weekday() >= 5:
            prev -= timedelta(days=1)
        date_str = prev.strftime('%Y%m%d')
        print(f'  Today empty, retrying with {date_str}')
        twse_data = fetch_json(TWSE_T86.format(date=date_str))
        by_symbol = parse_twse(twse_data)

    # Extract name map from sentinel key
    name_map = by_symbol.pop('__nameMap__', {}) if by_symbol else {}

    # 2026-05-19: 5-day rolling 三大法人 (主力越勢)
    # Accumulate today + last 4 trading days into a single picture.
    # Cumulative net flow = trend direction, NOT just today's snapshot.
    HISTORY_PATH = DATA_DIR / 'tw_institutions_history.json'
    history = {}
    if HISTORY_PATH.exists():
        try:
            history = json.loads(HISTORY_PATH.read_text())
        except Exception:
            history = {}

    # Add today's snapshot to history (keyed by date)
    if by_symbol:
        history[date_str] = {sym: v for sym, v in by_symbol.items() if not sym.startswith('__')}

    # Keep last 10 trading days only
    dates_sorted = sorted(history.keys(), reverse=True)[:10]
    history = {d: history[d] for d in dates_sorted}
    HISTORY_PATH.write_text(json.dumps(history, ensure_ascii=False))

    # Compute 5-day rolling cumulative for each ticker
    last5 = dates_sorted[:5]
    rolling = {}
    for sym in by_symbol:
        if sym.startswith('__'):
            continue
        cum_f, cum_t, cum_d, cum_tot = 0, 0, 0, 0
        days_present = 0
        for d in last5:
            day_data = history.get(d, {})
            if sym in day_data:
                cum_f   += day_data[sym].get('foreign', 0)
                cum_t   += day_data[sym].get('investmentTrust', 0)
                cum_d   += day_data[sym].get('dealer', 0)
                cum_tot += day_data[sym].get('total', 0)
                days_present += 1
        if days_present > 0:
            # 5-day conviction
            if cum_tot > 3000000 and cum_f > 0:
                conv5 = 'strong_accumulating'  # 主力連續吸籌
            elif cum_tot > 500000:
                conv5 = 'accumulating'
            elif cum_tot < -3000000 and cum_f < 0:
                conv5 = 'strong_distributing'  # 主力連續出貨
            elif cum_tot < -500000:
                conv5 = 'distributing'
            else:
                conv5 = 'neutral'
            # Merge into today's snapshot
            by_symbol[sym]['cum5d'] = {
                'foreign':         cum_f,
                'investmentTrust': cum_t,
                'dealer':          cum_d,
                'total':           cum_tot,
                'days':            days_present,
                'conviction':      conv5,
            }

    out = {
        'generatedAt': int(time.time() * 1000),
        'tradeDate':   date_str,
        'count':       len(by_symbol),
        'bySymbol':    by_symbol,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    strong_buys = [k for k,v in by_symbol.items() if v['conviction'] == 'strong_buy']
    print(f'✅ Wrote {OUT.name}: {len(by_symbol)} tickers, {len(strong_buys)} strong_buys')
    if strong_buys[:5]:
        print(f'   sample strong_buys: {strong_buys[:5]}')

    # 2026-05-19: Save Chinese name map for TW tickers (yfinance returns English
    # shortName for TW; TWSE provides authoritative Chinese names).
    if name_map:
        NAME_OUT = DATA_DIR / 'tw_name_map.json'
        NAME_OUT.write_text(json.dumps({
            'generatedAt': int(time.time() * 1000),
            'bySymbol':    name_map,
        }, ensure_ascii=False, indent=2))
        print(f'✅ Wrote tw_name_map.json: {len(name_map)} Chinese company names')

if __name__ == '__main__':
    main()
