#!/usr/bin/env python3
"""
score_news_finbert.py — 用 FinBERT 替代 Claude Haiku 做新聞 sentiment

FinBERT 是 ProsusAI 在 Financial PhraseBank + Reuters TRC2 上 fine-tune 的
BERT。在金融標題分類任務上比 generic LLM 準 ~15%，且免費可本地跑。

我們做兩個 path：
  (1) Hugging Face Inference API（免費 tier 1000 req/day，無需 GPU）
  (2) 本地 transformers（要 pip install transformers torch，初次 ~500MB 模型下載）
  → 預設先試 HF API，失敗 fallback 到本地

讀取 data/{market}_news_raw.json（fetch_news.py 已存好），逐 ticker 算 sentiment：
  - 對每篇標題給 bullish / bearish / neutral
  - 聚合：majority 投票 + confidence 平均
  - 輸出跟現有 us_news_sentiment.json 格式相容（方便 drop-in 替換）

Output: data/us_news_sentiment.json
{
  generatedAt, scannedAt, targetCount,
  bySymbol: {
    "NVDA": {
      sentiment: "bullish" | "bearish" | "mixed" | "neutral",
      summary: "N positive / N negative / N neutral headlines",
      keyHeadline: "...（confidence 最高的一條）",
      headlineCount: N,
      finbertScore: 0.78  # avg confidence on majority class
    }
  }
}
"""
import json
import sys
import os
import time
import urllib.request
import urllib.parse
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / 'data'

HF_TOKEN = os.environ.get('HF_TOKEN', '')  # optional, raises rate limit
HF_MODEL_URL = 'https://api-inference.huggingface.co/models/ProsusAI/finbert'

_local_pipeline = None  # lazy init

def hf_classify(text):
    """Hugging Face Inference API (free tier, 1000 req/day)"""
    body = json.dumps({'inputs': text[:512]}).encode('utf-8')
    headers = {'Content-Type': 'application/json'}
    if HF_TOKEN:
        headers['Authorization'] = f'Bearer {HF_TOKEN}'
    req = urllib.request.Request(HF_MODEL_URL, data=body, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode('utf-8'))
        # data shape: [[{label, score}, ...]]
        if isinstance(data, list) and data and isinstance(data[0], list):
            best = max(data[0], key=lambda x: x.get('score', 0))
            return {
                'label': best['label'].lower(),  # positive / negative / neutral
                'score': float(best['score']),
            }
    except Exception as e:
        if 'loading' in str(e).lower():
            time.sleep(5)  # model warming up, retry once
            try:
                with urllib.request.urlopen(req, timeout=20) as r:
                    data = json.loads(r.read().decode('utf-8'))
                if isinstance(data, list) and data and isinstance(data[0], list):
                    best = max(data[0], key=lambda x: x.get('score', 0))
                    return {'label': best['label'].lower(), 'score': float(best['score'])}
            except Exception:
                pass
        return None
    return None

def local_classify(text):
    """Local transformers fallback — needs pip install transformers torch"""
    global _local_pipeline
    if _local_pipeline is None:
        try:
            from transformers import pipeline
            _local_pipeline = pipeline('text-classification', model='ProsusAI/finbert', truncation=True)
        except ImportError:
            print('  ⚠ pip install transformers torch — local FinBERT unavailable')
            return None
        except Exception as e:
            print(f'  local model load fail: {e}')
            return None
    try:
        result = _local_pipeline(text[:512])[0]
        return {'label': result['label'].lower(), 'score': float(result['score'])}
    except Exception as e:
        return None

def classify(text):
    # Try HF API first, fallback to local
    r = hf_classify(text)
    if r:
        return r
    return local_classify(text)

def aggregate(headlines):
    """投票 + confidence 平均，回傳 dict"""
    results = []
    for h in headlines:
        title = h.get('title', '').strip()
        if not title:
            continue
        c = classify(title)
        if not c:
            continue
        results.append({'title': title, **c})
    if not results:
        return None
    # Count by label
    pos = [r for r in results if r['label'] == 'positive']
    neg = [r for r in results if r['label'] == 'negative']
    neu = [r for r in results if r['label'] == 'neutral']
    n_total = len(results)
    # Sentiment label
    if pos and len(pos) / n_total >= 0.6:
        sentiment = 'bullish'
    elif neg and len(neg) / n_total >= 0.6:
        sentiment = 'bearish'
    elif pos and neg and abs(len(pos) - len(neg)) <= 1:
        sentiment = 'mixed'
    elif pos and len(pos) > len(neg):
        sentiment = 'bullish'
    elif neg and len(neg) > len(pos):
        sentiment = 'bearish'
    else:
        sentiment = 'neutral'
    # Key headline = highest confidence one from majority class
    pool = pos if sentiment == 'bullish' else neg if sentiment == 'bearish' else results
    key = max(pool, key=lambda x: x['score']) if pool else results[0]
    # Avg confidence of majority class
    avg_score = sum(r['score'] for r in pool) / max(len(pool), 1)
    return {
        'sentiment':     sentiment,
        'summary':       f'{len(pos)} bull / {len(neg)} bear / {len(neu)} neutral',
        'keyHeadline':   key['title'][:200],
        'headlineCount': n_total,
        'finbertScore':  round(avg_score, 3),
    }

def main():
    market = (sys.argv[1] if len(sys.argv) > 1 else 'us').lower()
    news_file = DATA_DIR / f'{market}_news_raw.json'
    if not news_file.exists():
        print(f'ERROR: {news_file} missing — run fetch_news.py {market} first')
        sys.exit(1)
    raw = json.loads(news_file.read_text())
    by_symbol_raw = raw.get('bySymbol', {})
    if not by_symbol_raw:
        print('No news data')
        sys.exit(0)

    print(f'FinBERT scoring news for {len(by_symbol_raw)} {market.upper()} tickers '
          f'(HF API + local fallback)...')

    by_symbol = {}
    for i, (sym, headlines) in enumerate(by_symbol_raw.items(), 1):
        if not headlines:
            continue
        agg = aggregate(headlines)
        if agg:
            by_symbol[sym] = {**agg, 'analyzedAt': int(time.time() * 1000)}
            print(f'  [{i}/{len(by_symbol_raw)}] {sym}: {agg["sentiment"]} '
                  f'({agg["summary"]}, conf {agg["finbertScore"]})')
        else:
            print(f'  [{i}/{len(by_symbol_raw)}] {sym}: skip (no classify)')
        # HF free tier rate limit polite
        time.sleep(0.3)

    out = {
        'generatedAt': int(time.time() * 1000),
        'scannedAt':   __import__('datetime').datetime.now().isoformat(),
        'targetCount': len(by_symbol),
        'model':       'ProsusAI/finbert',
        'bySymbol':    by_symbol,
    }
    out_path = DATA_DIR / f'{market}_news_sentiment.json'
    out_path.write_text(json.dumps(out, indent=2, ensure_ascii=False))
    bull = sum(1 for v in by_symbol.values() if v['sentiment'] == 'bullish')
    bear = sum(1 for v in by_symbol.values() if v['sentiment'] == 'bearish')
    print(f'\n✅ Wrote {out_path.name}: {len(by_symbol)} symbols · '
          f'{bull} bullish · {bear} bearish')

if __name__ == '__main__':
    main()
