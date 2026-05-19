#!/usr/bin/env python3
"""
fetch_news.py — Fetch recent news headlines, dump to JSON.

US: yfinance ticker.news (Yahoo aggregated, mostly English)
TW: yfinance + Google News RSS (zh-TW) using Chinese company name —
    finds 鉅亨網/經濟日報/工商時報/MoneyDJ articles via Google's index.

Output: data/{market}_news_raw.json
  { generatedAt, market, bySymbol: { TICKER: [{title, publisher, link, pubTime}] } }
"""
import yfinance as yf
import json
import sys
import time
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / 'data'

def parse_yf_news(news_items, max_n=10):
    out = []
    for item in (news_items or [])[:max_n]:
        content = item.get('content', item)
        title = content.get('title') or item.get('title')
        if not title:
            continue
        provider = content.get('provider')
        publisher = ''
        if isinstance(provider, dict):
            publisher = provider.get('displayName', '')
        else:
            publisher = item.get('publisher', '') or ''
        link = ''
        canonical = content.get('canonicalUrl')
        if isinstance(canonical, dict):
            link = canonical.get('url', '')
        if not link:
            link = item.get('link', '') or ''
        out.append({
            'title':     title,
            'publisher': publisher,
            'link':      link,
            'pubTime':   content.get('pubDate') or item.get('providerPublishTime') or '',
            'source':    'yfinance',
        })
    return out

def fetch_google_news_zh_tw(query):
    """Fetch zh-TW news headlines from Google News RSS for a search query."""
    q = urllib.parse.quote(query)
    url = f'https://news.google.com/rss/search?q={q}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant'
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept-Language': 'zh-TW,zh;q=0.9',
        })
        with urllib.request.urlopen(req, timeout=10) as r:
            xml_text = r.read().decode('utf-8')
        root = ET.fromstring(xml_text)
        items = []
        for item in root.findall('.//item')[:10]:
            title = (item.findtext('title') or '').strip()
            link  = (item.findtext('link')  or '').strip()
            pub   = (item.findtext('pubDate') or '').strip()
            # Source comes from <source url=...>Publisher Name</source>
            source_elem = item.find('source')
            publisher = source_elem.text.strip() if source_elem is not None and source_elem.text else ''
            # Google News titles include " - Publisher" suffix — strip it
            if publisher and title.endswith(f' - {publisher}'):
                title = title[:-(len(publisher) + 3)].strip()
            if title:
                items.append({
                    'title':     title,
                    'publisher': publisher,
                    'link':      link,
                    'pubTime':   pub,
                    'source':    'google_news_zh_tw',
                })
        return items
    except Exception as e:
        print(f'    google news failed: {str(e)[:60]}')
        return []

def dedupe_headlines(items):
    seen_titles = set()
    out = []
    for it in items:
        # Dedupe by lowercased first 30 chars of title
        key = (it.get('title') or '').lower().strip()[:30]
        if key and key not in seen_titles:
            seen_titles.add(key)
            out.append(it)
    return out

def main():
    market = (sys.argv[1] if len(sys.argv) > 1 else 'us').lower()
    scan_file = DATA_DIR / f'{market}_scan.json'
    if not scan_file.exists():
        print(f'ERROR: {scan_file} missing — run scan first')
        sys.exit(1)
    scan = json.loads(scan_file.read_text())
    leaders     = scan.get('leaders', [])
    discoveries = scan.get('discoveries', [])
    merged = leaders + discoveries
    merged.sort(key=lambda r: r.get('compositeScore', 0), reverse=True)
    seen = set()
    targets = []
    for r in merged:
        sym = r.get('symbol')
        if sym and sym not in seen:
            seen.add(sym)
            targets.append((sym, r.get('name', sym)))
        if len(targets) >= 20:
            break

    # Load TW Chinese name map for better Google News queries
    tw_name_map = {}
    nmf = DATA_DIR / 'tw_name_map.json'
    if nmf.exists():
        try:
            tw_name_map = json.loads(nmf.read_text()).get('bySymbol', {})
        except Exception:
            pass

    is_tw_market = (market == 'tw')
    print(f'Fetching news for {len(targets)} {market.upper()} symbols' +
          (' (yfinance + Google News zh-TW)' if is_tw_market else ' (yfinance)') + '...')

    by_symbol = {}
    for i, (sym, name) in enumerate(targets, 1):
        all_items = []
        # 1) Always try yfinance (works for both US + TW, English-leaning)
        try:
            all_items.extend(parse_yf_news(yf.Ticker(sym).news, max_n=10))
        except Exception as e:
            print(f'  [{i}/{len(targets)}] {sym}: yfinance failed — {str(e)[:60]}')

        # 2) For TW: also fetch Google News zh-TW with Chinese name
        if is_tw_market:
            code = sym.replace('.TW', '').replace('.TWO', '')
            cname = tw_name_map.get(code, '')
            query = f'{code} {cname}' if cname else f'{code} 台股'
            gn = fetch_google_news_zh_tw(query)
            all_items.extend(gn)

        deduped = dedupe_headlines(all_items)[:12]
        by_symbol[sym] = deduped
        source_summary = ''
        if is_tw_market:
            yf_count = sum(1 for it in deduped if it.get('source') == 'yfinance')
            gn_count = sum(1 for it in deduped if it.get('source') == 'google_news_zh_tw')
            source_summary = f' (yf={yf_count}, zh-TW={gn_count})'
        print(f'  [{i}/{len(targets)}] {sym}: {len(deduped)} headlines{source_summary}')
        if i % 5 == 0:
            time.sleep(0.4)

    out = {
        'generatedAt': int(time.time() * 1000),
        'market':      market.upper(),
        'bySymbol':    by_symbol,
    }
    out_path = DATA_DIR / f'{market}_news_raw.json'
    out_path.write_text(json.dumps(out, indent=2, ensure_ascii=False))
    total = sum(len(v) for v in by_symbol.values())
    print(f'\nWrote {out_path.name}: {len(by_symbol)} symbols, {total} headlines total')

if __name__ == '__main__':
    main()
