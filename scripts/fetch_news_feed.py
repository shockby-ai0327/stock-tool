#!/usr/bin/env python3
"""
fetch_news_feed.py — server-side category news feed for the 市場情報 news page.

WHY THIS EXISTS
---------------
The news page used to fetch RSS in the browser through public CORS proxies
(corsproxy.io / allorigins / a Cloudflare worker). Those die constantly — the
worker began 403/CORS-failing and the page broke (esp. the 台股 tab: every
Taiwan RSS feed is CORS-blocked in-browser). GitHub Actions can fetch the feeds
server-side with zero CORS, so we pull them here and commit one JSON the
frontend reads — same pattern as every other data file in this tool.

(Per-symbol headlines for 漲跌解讀 attribution come from the existing
fetch_news.py → {market}_news_raw.json; this script only does the page's
category tabs: 綜合 / 美股 / 台股 / 加密.)

Output: data/news_feed.json
  { generatedAt, categories: { general, us, tw, crypto } }   item: {title,link,pubDate,source}

Stdlib only (urllib + xml.etree) — no extra pip deps.
"""

import json
import os
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from xml.etree import ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "..", "data")
UA = "Mozilla/5.0 (compatible; stock-tool-news/1.0; +https://github.com/shockby-ai0327/stock-tool)"

GNEWS = "https://news.google.com/rss/search?q={q}&hl={hl}&gl={gl}&ceid={ceid}"
CATEGORIES = {
    "general": GNEWS.format(q=urllib.parse.quote("stock market"), hl="en-US", gl="US", ceid="US:en"),
    "us":      GNEWS.format(q=urllib.parse.quote("US stocks S&P 500 Nasdaq"), hl="en-US", gl="US", ceid="US:en"),
    "tw":      GNEWS.format(q=urllib.parse.quote("台股 台積電 上市櫃"), hl="zh-TW", gl="TW", ceid="TW:zh-Hant"),
    "crypto":  GNEWS.format(q=urllib.parse.quote("cryptocurrency bitcoin ethereum"), hl="en-US", gl="US", ceid="US:en"),
}
MAX_PER_CAT = 40


def fetch(url, timeout=12):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def parse_rss(xml_bytes, limit):
    out = []
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return out
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        if not title:
            continue
        src_el = item.find("source")
        source = (src_el.text.strip() if src_el is not None and src_el.text else "")
        # Google News titles are "Headline - Source"; drop the trailing source dupe
        if source and title.endswith(" - " + source):
            title = title[: -(len(source) + 3)].strip()
        out.append({
            "title": title,
            "link": (item.findtext("link") or "").strip(),
            "pubDate": (item.findtext("pubDate") or "").strip(),
            "source": source,
        })
        if len(out) >= limit:
            break
    return out


def main():
    print("=== Server-side category news feed ===")
    categories = {}
    for cat, url in CATEGORIES.items():
        try:
            items = parse_rss(fetch(url), MAX_PER_CAT)
            categories[cat] = items
            print(f"  {cat}: {len(items)} items")
        except Exception as e:
            categories[cat] = []
            print(f"  {cat}: FAILED {str(e)[:80]}")
        time.sleep(0.4)

    out = {
        "generatedAt": int(datetime.now(timezone.utc).timestamp() * 1000),
        "categories": categories,
    }
    with open(os.path.join(DATA_DIR, "news_feed.json"), "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    total = sum(len(v) for v in categories.values())
    print(f"  wrote news_feed.json — {total} items across {len(categories)} categories")


if __name__ == "__main__":
    main()
