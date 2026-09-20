#!/usr/bin/env python3
"""毎日の相場取得。

eBay（日本から発送されている出品）の価格と販売数、楽天市場・Yahoo!ショッピングの価格、
（キーがあれば）Etsy の日本ショップの価格を集めて docs/data/*.json に書き出す。

環境変数:
  EBAY_CLIENT_ID, EBAY_CLIENT_SECRET          必須
  RAKUTEN_APP_ID, RAKUTEN_ACCESS_KEY          任意（楽天市場の価格）
  RAKUTEN_REFERER                             任意（楽天アプリに許可サイトを登録した場合）
  YAHOO_CLIENT_ID                             任意（Yahoo!ショッピングの価格）
  ETSY_API_KEY                                任意（"keystring:shared_secret" の形）

使い方:
  python scripts/fetch.py               全商品
  python scripts/fetch.py --only nikon-fm2 --dry-run   1商品だけ試して保存しない
"""
from __future__ import annotations

import argparse
import base64
import html
import json
import os
import re
import statistics
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "watchlist.json"
DATA_DIR = ROOT / "docs" / "data"
STATE_PATH = ROOT / "data" / "state.json"

JST = timezone(timedelta(hours=9))
HISTORY_DAYS = 180
STATE_KEEP_DAYS = 14
RECHECK_DAYS = 7              # 検索に出なくなった出品を何日間追いかけるか
MAX_TRACK_PER_PRODUCT = 30    # 1商品あたり販売数を調べる出品数（eBay の1日の上限内に収める）
MAX_TRACK_PER_QUERY = 25      # 売れ筋検索1クエリあたり
DISCOVERY_TOP = 20
USER_AGENT = "jp-resale-watch/1.0"
GONE = "GONE"                 # eBay 上で出品が終了している


def log(msg):
    print(msg, flush=True)


# ---------------------------------------------------------------- HTTP

class ApiError(Exception):
    def __init__(self, status, body):
        super().__init__(f"HTTP {status}: {body}")
        self.status = status


def http_json(url, headers=None, data=None, timeout=30, retries=3):
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(
            url, data=data,
            headers={"User-Agent": USER_AGENT, "Accept": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return json.load(res)
        except urllib.error.HTTPError as e:
            last = ApiError(e.code, e.read().decode("utf-8", "replace")[:400])
            if e.code not in (429, 500, 502, 503, 504):
                break
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = ApiError(0, str(e))
        if attempt < retries - 1:
            time.sleep(2 * 2 ** attempt)
    raise last


# ---------------------------------------------------------------- 文字列・数値

def norm(text):
    """全角半角・大小文字・空白やハイフンの違いを無視して照合するための正規化。"""
    t = unicodedata.normalize("NFKC", text or "").lower()
    return "".join(ch for ch in t if not ch.isspace() and ch not in "-_・/")


def has_token(title, token):
    t = norm(token)
    if re.search(r"\d", t) or len(t) <= 2:
        # 型番のように数字を含む語は、前後に英数字が続かないことを確かめる
        # （「67」が「15670」に、「FM2」が「ワイドFM 25W」に当たらないように）
        loose = unicodedata.normalize("NFKC", title or "").lower()
        # 数字で始まる語（50mm、1.4）は「F1.4」のように前に英字が付いてもよい
        before = r"(?<![0-9.])" if t[0].isdigit() else r"(?<![0-9a-z])"
        pat = before + r"[\s\-_・/]*".join(map(re.escape, t)) + r"(?![0-9a-z])"
        return re.search(pat, loose) is not None
    return t in norm(title)


def title_ok(title, must, exclude):
    t = norm(title)
    return all(has_token(title, m) for m in must) and not any(norm(x) in t for x in exclude)


def quantile(values, q):
    v = sorted(values)
    if not v:
        return None
    pos = (len(v) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(v) - 1)
    return v[lo] + (v[hi] - v[lo]) * (pos - lo)


def median(values):
    return round(statistics.median(values), 2) if values else None


def days_ago(today, n):
    return (date.fromisoformat(today) - timedelta(days=n)).isoformat()


# ---------------------------------------------------------------- 為替

def fetch_fx(fallback):
    sources = [
        ("frankfurter", "https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY"),
        ("exchangerate-api", "https://open.er-api.com/v6/latest/USD"),
    ]
    for name, url in sources:
        try:
            return float(http_json(url, retries=2)["rates"]["JPY"]), name
        except Exception as e:  # noqa: BLE001 - 次の取得元を試す
            log(f"  為替 {name} 失敗: {e}")
    return float(fallback), "fallback"


# ---------------------------------------------------------------- eBay

class Ebay:
    API = "https://api.ebay.com"

    def __init__(self, client_id, client_secret):
        basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        body = urllib.parse.urlencode({
            "grant_type": "client_credentials",
            "scope": "https://api.ebay.com/oauth/api_scope",
        }).encode()
        token = http_json(f"{self.API}/identity/v1/oauth2/token", {
            "Authorization": f"Basic {basic}",
            "Content-Type": "application/x-www-form-urlencoded",
        }, data=body)
        self.headers = {
            "Authorization": f"Bearer {token['access_token']}",
            "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
            # 送料をアメリカ向けで計算させる
            "X-EBAY-C-ENDUSERCTX": "contextualLocation=country%3DUS%2Czip%3D10001",
        }
        self.calls = 0
        self.batch_ok = True
        self._lock = threading.Lock()

    def _get(self, path):
        with self._lock:
            self.calls += 1
        return http_json(self.API + path, self.headers)

    def search(self, q, min_usd=0, cond="any", limit=200):
        filters = ["itemLocationCountry:JP", "buyingOptions:{FIXED_PRICE}"]
        if cond == "new":
            filters.append("conditions:{NEW}")
        elif cond == "used":
            filters.append("conditions:{USED}")
        priced = filters + [f"price:[{min_usd}..]", "priceCurrency:USD"] if min_usd else filters

        def run(fs):
            qs = urllib.parse.urlencode({"q": q, "limit": limit, "filter": ",".join(fs)})
            return self._get("/buy/browse/v1/item_summary/search?" + qs).get("itemSummaries", [])

        try:
            return run(priced)
        except ApiError as e:
            if e.status != 400 or priced is filters:
                raise
            return run(filters)  # 価格フィルターが通らない場合も取得は続ける（下限は手元で弾く）

    def item(self, item_id):
        try:
            return self._get("/buy/browse/v1/item/" + urllib.parse.quote(item_id, safe=""))
        except ApiError as e:
            if e.status == 404:
                return GONE
            if 400 <= e.status < 500:
                return None  # バリエーション出品など、単体では取れないもの
            raise

    def details(self, ids):
        """出品の詳細。20件ずつまとめて取り（1日の呼び出し上限の節約）、取れなかった分だけ1件ずつ取る。"""
        ids = list(dict.fromkeys(ids))
        out = {}
        if self.batch_ok:
            for i in range(0, len(ids), 20):
                chunk = ids[i:i + 20]
                try:
                    res = self._get("/buy/browse/v1/item/?item_ids=" + ",".join(urllib.parse.quote(x, safe="") for x in chunk))
                except ApiError as e:
                    log(f"    まとめて取得できないので1件ずつ取ります: {e}")
                    self.batch_ok = False
                    break
                for it in res.get("items") or []:
                    if it.get("itemId") in chunk:
                        out[it["itemId"]] = it

        def one(iid):
            try:
                return iid, self.item(iid)
            except ApiError as e:
                log(f"    getItem {iid} 失敗: {e}")
                return iid, None

        rest = [x for x in ids if x not in out]  # 終わった出品やバリエーション出品など
        with ThreadPoolExecutor(max_workers=4) as pool:
            out.update(dict(pool.map(one, rest)))
        return out


def usd(amount):
    if not amount or amount.get("currency", "USD") != "USD":
        return None
    try:
        return float(amount["value"])
    except (KeyError, TypeError, ValueError):
        return None


def landed_usd(item):
    """商品価格＋アメリカ向け送料（買い手の支払総額）。"""
    price = usd(item.get("price"))
    if price is None:
        return None
    options = item.get("shippingOptions") or []
    ship = usd(options[0].get("shippingCost")) if options else None
    return round(price + (ship or 0.0), 2)


def sold_quantity(detail):
    return sum(int(a.get("estimatedSoldQuantity") or 0) for a in detail.get("estimatedAvailabilities") or [])


def listing_from_summary(s):
    return {
        "id": s["itemId"],
        "t": s.get("title", ""),
        "p": landed_usd(s),
        "u": s.get("itemWebUrl"),
        "i": (s.get("image") or {}).get("imageUrl")
             or ((s.get("thumbnailImages") or [{}])[0]).get("imageUrl"),
        "sl": (s.get("seller") or {}).get("username"),
    }


# ---------------------------------------------------------------- 同じ品物を日本で探すための手がかり

COLORS = {  # 英語の色 → 日本の出品タイトルでよく使う書き方
    "black": ["ブラック", "黒"], "white": ["ホワイト", "白"], "silver": ["シルバー", "銀"], "gold": ["ゴールド", "金"],
    "red": ["レッド", "赤"], "blue": ["ブルー", "青"], "navy": ["ネイビー", "紺"], "green": ["グリーン", "緑"],
    "yellow": ["イエロー", "黄"], "pink": ["ピンク"], "purple": ["パープル", "紫"], "orange": ["オレンジ"],
    "gray": ["グレー", "灰"], "grey": ["グレー", "灰"], "brown": ["ブラウン", "茶"], "beige": ["ベージュ"],
    "clear": ["クリア"], "khaki": ["カーキ"], "titanium": ["チタン"],
}
GENERIC_MPN = {"doesnotapply", "na", "n/a", "none", "unbranded", "notapplicable", "unknown", "doesntapply", "-"}
# 型番に見えるが商品を特定しない語（鋼材・電圧・電池の規格など）
NOT_A_MODEL = re.compile(r"^(\d+v|vg\d+|aus\d+|sus\d+|sk\d|hrc\d+|\d+k|\d+w|\d+ml|\d+mm|cr\d+|lr\d+|\d+mah)$", re.I)
BRANDS = {  # eBay のブランド名 → 日本の出品での書かれ方
    "nikon": ["ニコン"], "canon": ["キヤノン", "キャノン"], "casio": ["カシオ"], "seiko": ["セイコー"],
    "citizen": ["シチズン"], "pentax": ["ペンタックス"], "olympus": ["オリンパス"], "ricoh": ["リコー"],
    "mamiya": ["マミヤ"], "konica": ["コニカ"], "minolta": ["ミノルタ"], "fujifilm": ["フジフイルム", "富士フイルム"],
    "fuji": ["フジ"], "contax": ["コンタックス"], "yashica": ["ヤシカ"], "nintendo": ["任天堂", "ニンテンドウ", "ニンテンドー"],
    "sega": ["セガ"], "sony": ["ソニー"], "snk": ["ネオジオ"], "nec": ["ＮＥＣ"], "bandai": ["バンダイ"],
    "pokemon": ["ポケモン"], "issey miyake": ["イッセイミヤケ", "イッセイ ミヤケ"], "porter": ["ポーター", "吉田カバン"],
    "kapital": ["キャピタル"], "tojiro": ["藤次郎", "藤寅"], "sakai takayuki": ["堺孝行"], "shun": ["旬"],
}
MODEL_RE = re.compile(r"(?<![A-Za-z0-9])(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*")
NOT_MODEL_RE = re.compile(r"^(\d+(mm|cm|ml|g|kg|s|th|st|nd|rd|pcs?|x)|f\d.*|s/?n.*|no\d+|exc\d*|\d+x\d+)$", re.I)


def model_of(title, detail):
    """出品の型番。eBay の「MPN / Model」欄を優先し、無ければタイトルの英数字の並びから拾う。"""
    aspects = {a.get("name", "").lower(): a.get("value", "") for a in (detail or {}).get("localizedAspects") or []}
    for v in ((detail or {}).get("mpn"), aspects.get("mpn"), aspects.get("model"), aspects.get("reference number"),
              aspects.get("model number")):
        v = (v or "").split(",")[0].strip()
        if " " in v:  # 「Nikon FM2」のようにブランド込みなら、数字を含む部分だけにする
            v = next((w for w in v.split() if re.search(r"\d", w)), v)
        if (v and norm(v) not in GENERIC_MPN and not NOT_A_MODEL.match(v.replace("-", ""))
                and re.search(r"\d", v) and re.search(r"[A-Za-z]", v) and len(v) <= 30):
            return v
    tokens = [t for t in MODEL_RE.findall(title or "")
              if len(norm(t)) >= 4 and not NOT_MODEL_RE.match(t) and not NOT_A_MODEL.match(t.replace("-", ""))]
    return max(tokens, key=lambda t: len(norm(t))) if tokens else None


def brand_of(detail):
    aspects = {a.get("name", "").lower(): a.get("value", "") for a in (detail or {}).get("localizedAspects") or []}
    b = ((detail or {}).get("brand") or aspects.get("brand") or "").strip()
    return b if b and norm(b) not in GENERIC_MPN else None


def brand_ok(title, brand):
    """日本の出品タイトルに、そのブランドが（英語でもカタカナでも）入っているか。"""
    if not brand:
        return True
    names = [brand] + BRANDS.get(brand.lower(), [])
    return any(norm(n) in norm(title) for n in names)


def color_of(detail):
    aspects = {a.get("name", "").lower(): a.get("value", "") for a in (detail or {}).get("localizedAspects") or []}
    raw = ((detail or {}).get("color") or aspects.get("color") or aspects.get("dial color") or "").lower()
    return next((c for c in COLORS if re.search(rf"\b{c}\b", raw)), None)


def other_color(title, color):
    """日本の出品が、指定と違う色だとはっきり書いているか。"""
    if not color:
        return False
    t = unicodedata.normalize("NFKC", title or "")
    mine = COLORS[color]
    if any(w in t for w in mine):
        return False
    return any(w in t for c, words in COLORS.items() if words != mine for w in words if len(w) > 1)


# ---------------------------------------------------------------- 販売数の追跡

class Tracker:
    """出品ごとの累計販売数を毎日記録し、前日との差を「その日に売れた数」とする。

    items[itemId] = {g: ジャンル, p: 商品ID|None, s: 最新の累計販売数,
                     ps: 前日終了時点の累計販売数, d: 最後に調べた日, seen: 最後に検索に出た日,
                     gone: 出品終了を確認した日, pr: 最後に見た価格(USD), sl: 売り手}
    """

    def __init__(self, state, today):
        self.items = state.setdefault("items", {})
        self.today = today

    def _roll(self, e):
        if e["d"] != self.today:
            e["ps"], e["d"] = e["s"], self.today

    def observe(self, item_id, sold, genre, product=None, in_search=True, price=None, seller=None, ident=None):
        e = self.items.get(item_id)
        if e is None:
            e = self.items[item_id] = {"g": genre, "s": sold, "ps": None, "d": self.today}
        else:
            self._roll(e)
            e["s"] = sold
            e.pop("gone", None)
        if in_search:
            e["seen"] = self.today
        if product and not e.get("p"):
            e["p"] = product
        if price is not None:
            e["pr"] = price
        if seller:
            e["sl"] = seller
        if ident:
            e.update(ident)  # 終わった出品でも日本の同じ品物を探せるよう、型番・色・タイトルを残す
        return e

    def sales_today(self, match):
        """今日わかった販売: [日付, 価格, 個数, 種類(q=複数個出品の販売 / e=出品終了)]"""
        out = []
        for e in self.items.values():
            if not match(e) or e["d"] != self.today or e.get("pr") is None:
                continue
            if self.delta(e):
                out.append([self.today, e["pr"], self.delta(e), "q"])
            if e.get("gone") == self.today:
                out.append([self.today, e["pr"], 1, "e"])
        return out

    def mark_gone(self, item_id):
        e = self.items[item_id]
        self._roll(e)
        e["gone"] = self.today

    def pending(self, match):
        """最近まで検索に出ていたのに今日は出てこなかった出品。"""
        since = days_ago(self.today, RECHECK_DAYS)
        return [iid for iid, e in self.items.items()
                if match(e) and "gone" not in e and e["d"] != self.today and e.get("seen", e["d"]) >= since]

    def delta(self, e):
        if e["d"] != self.today or e["ps"] is None:
            return 0
        return max(0, e["s"] - e["ps"])

    def summary(self, match):
        today = [e for e in self.items.values() if match(e) and e["d"] == self.today]
        return {
            "s1": sum(self.delta(e) for e in today),
            "v1": sum(1 for e in today if e.get("gone") == self.today),
            "n": sum(1 for e in today if e.get("seen") == self.today),
        }

    def prune(self):
        keep_since = days_ago(self.today, STATE_KEEP_DAYS)
        gone_since = days_ago(self.today, 7)  # 終わった出品は1週間、日本の同じ品物探しに使う
        for iid in [iid for iid, e in self.items.items()
                    if e["d"] < keep_since or e.get("gone", "9999") < gone_since]:
            del self.items[iid]


def recheck(ebay, tracker, match, genre, product=None):
    ids = tracker.pending(match)
    for iid, d in ebay.details(ids).items():
        if d is GONE:
            tracker.mark_gone(iid)
        elif isinstance(d, dict):
            tracker.observe(iid, sold_quantity(d), genre, product, in_search=False, price=landed_usd(d))
    return len(ids)


def liquidity(events, tracked, sellers, today):
    """売れた記録から流動性の数字を出す。events = [[日付, 価格, 個数, 種類], ...]"""
    since = {n: days_ago(today, n) for n in (7, 14, 30)}
    ev30 = [e for e in events if e[0] > since[30]]
    s30 = sum(e[2] for e in ev30)
    # 1つの出品の大量販売に引っぱられないよう、1記録あたり最大3個分として価格を数える
    prices = [e[1] for e in ev30 for _ in range(min(e[2], 3))]
    return {
        "s7": sum(e[2] for e in events if e[0] > since[7]),
        "s30": s30,
        "d14": len({e[0] for e in events if e[0] > since[14]}),
        "str": round(s30 / (s30 + tracked), 3) if s30 + tracked else None,
        "dos": round(tracked / (s30 / 30)) if s30 else None,
        "med": median(prices),
        "cnt": len(prices),
        "tracked": tracked,
        "sellers": sellers,
    }


# ---------------------------------------------------------------- 日本側・Etsy

class Rakuten:
    URL = "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701"

    def __init__(self, app_id, access_key, referer=None):
        self.params = {"applicationId": app_id, "accessKey": access_key}
        self.headers = {}
        if referer:
            u = urllib.parse.urlsplit(referer)
            self.headers = {"Referer": referer, "Origin": f"{u.scheme}://{u.netloc}"}

    def search(self, keyword, min_jpy):
        params = {**self.params, "keyword": keyword, "format": "json", "formatVersion": 2,
                  "hits": 30, "sort": "+itemPrice", "availability": 1}
        if min_jpy:
            params["minPrice"] = int(min_jpy)
        res = http_json(f"{self.URL}?{urllib.parse.urlencode(params)}", self.headers)
        time.sleep(1.1)
        self.last_keys = sorted(res)[:8]  # 0件のときの切り分け用
        out = []
        # formatVersion=2 は {"Items": [{...}]}、1 は {"Items": [{"Item": {...}}]}
        for it in res.get("Items") or res.get("items") or []:
            it = it.get("Item", it)
            img = (it.get("mediumImageUrls") or [None])[0]
            out.append({
                "t": it.get("itemName", ""),
                "p": int(it.get("itemPrice") or 0),
                "u": it.get("itemUrl"),
                "i": img.get("imageUrl") if isinstance(img, dict) else img,
                "shop": it.get("shopName"),
                "src": "楽天",
            })
        return out


class YahooShopping:
    URL = "https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch"

    def __init__(self, client_id):
        self.client_id = client_id

    def search(self, query, min_jpy, cond):
        params = {"appid": self.client_id, "query": query, "results": 50,
                  "sort": "+price", "in_stock": "true"}
        if min_jpy:
            params["price_from"] = int(min_jpy)
        if cond in ("new", "used"):
            params["condition"] = cond
        res = http_json(f"{self.URL}?{urllib.parse.urlencode(params)}")
        time.sleep(1.1)  # 1秒に1回まで
        return [{
            "t": it.get("name", ""),
            "p": int(it.get("price") or 0),
            "u": it.get("url"),
            "i": (it.get("image") or {}).get("medium"),
            "shop": (it.get("seller") or {}).get("name"),
            "src": "Yahoo!",
        } for it in res.get("hits", [])]


class Etsy:
    API = "https://openapi.etsy.com/v3/application"

    def __init__(self, api_key):
        self.headers = {"x-api-key": api_key}
        self.calls = 0

    def _get(self, path):
        self.calls += 1
        time.sleep(0.25)  # 1秒に数回までに抑える
        return http_json(self.API + path, self.headers)

    def search(self, keywords, fx, sort_on="score"):
        """日本にあるショップの出品中の商品。"""
        qs = urllib.parse.urlencode({"keywords": keywords, "shop_location": "Japan", "limit": 100,
                                     "sort_on": sort_on})
        rows = (etsy_listing(r, fx) for r in self._get(f"/listings/active?{qs}").get("results", []))
        return [x for x in rows if x]

    def listing(self, listing_id):
        try:
            return self._get(f"/listings/{listing_id}")
        except ApiError as e:
            if e.status == 404:
                return GONE
            if 400 <= e.status < 500:
                return None
            raise

    def shop(self, shop_id):
        """ショップの累計販売数（Etsy が公開している、そのショップがこれまでに売った数）。"""
        try:
            r = self._get(f"/shops/{shop_id}")
        except ApiError as e:
            log(f"    Etsy ショップ {shop_id} 失敗: {e}")
            return None
        return {"name": r.get("shop_name"), "sold": r.get("transaction_sold_count"),
                "url": r.get("url"), "since": r.get("create_date") or r.get("created_timestamp")}


def etsy_listing(r, fx):
    price = r.get("price") or {}
    if not price.get("amount"):
        return None
    amount = price["amount"] / (price.get("divisor") or 1)
    currency = price.get("currency_code")
    if currency == "JPY":
        amount /= fx
    elif currency != "USD":
        return None
    return {"id": str(r["listing_id"]), "t": html.unescape(r.get("title", "")), "p": round(amount, 2),
            "qty": r.get("quantity"), "fav": r.get("num_favorers") or 0, "u": r.get("url"),
            "shop_id": r.get("shop_id"), "created": r.get("original_creation_timestamp")}


# ---------------------------------------------------------------- 売れた出品と日本の同じ品物

MAX_PAIRS = 4


def has_model(title, model):
    """型番が、前後に英数字が続かない形でタイトルに入っているか（DW-5600 が DW-5600BB に当たらない）。"""
    t = norm(model)
    loose = unicodedata.normalize("NFKC", title or "").lower()
    pat = r"(?<![0-9a-z])" + r"[\s\-_・/]*".join(map(re.escape, t)) + r"(?![0-9a-z])"
    return re.search(pat, loose) is not None


def find_same_in_japan(ctx, c, must_ja, exclude, q_ja):
    """売れた eBay 出品 c と同じ品物の、日本でいちばん安い出品。

    同じ型番であることに加えて、ブランド名と、その商品に必ず入る語（牛刀・本体など）も
    タイトルに入っていることを求める。型番だけだと、鋼材名や電圧が同じだけの別商品に当たるため。
    """
    floor = round(c["p"] * ctx["fx"] * ctx["settings"].get("jp_floor_ratio", 0.2))
    cache = ctx["state"].setdefault("jpmatch", {})
    key = f"{norm(c['k'])}|{c.get('c') or ''}|{c.get('b') or ''}|{norm(''.join(must_ja))}|{floor // 1000}"
    if key in cache and cache[key]["d"] >= days_ago(ctx["today"], 1):
        return cache[key]["jp"]

    colors = COLORS.get(c.get("c") or "", [])
    queries = [f"{q_ja} {c['k']}", c["k"]]
    if colors:
        queries.insert(1, f"{c['k']} {colors[0]}")
    best = None
    for q in queries:
        found = []
        for name, client in (("楽天", ctx["rakuten"]), ("Yahoo!", ctx["yahoo"])):
            if not client:
                continue
            try:
                found += client.search(q, floor) if name == "楽天" else client.search(q, floor, "any")
            except ApiError as e:
                log(f"      {name}「{q}」失敗: {e}")
        hits = [x for x in found if x["p"] >= floor and has_model(x["t"], c["k"])
                and brand_ok(x["t"], c.get("b")) and title_ok(x["t"], must_ja, exclude)
                and not other_color(x["t"], c.get("c"))]
        if hits:
            x = min(hits, key=lambda h: h["p"])
            best = {k: x.get(k) for k in ("t", "p", "u", "src", "shop")} | {"n": len(hits), "q": q}
            break
    cache[key] = {"d": ctx["today"], "jp": best}
    return best


def pair_with_japan(ctx, tracked, pid, must_ja, exclude, q_ja):
    """今日売れている出品と、この1週間に終わった出品のうち、型番がわかるものを日本と組み合わせる。"""
    cands = [{"t": x["t"], "p": x["p"], "s": x["s"], "u": x["u"], "i": x.get("i"), "k": x["k"], "c": x.get("c"),
              "b": x.get("b"), "kind": "sold"}
             for x in tracked if x.get("s", 0) > 0 and x.get("k")]
    cands += [{"t": e.get("t", ""), "p": e["pr"], "s": 1, "u": e.get("u"), "i": None, "k": e["k"], "c": e.get("c"),
               "b": e.get("b"), "kind": "ended"}
              for e in ctx["tracker"].items.values()
              if e.get("p") == pid and e.get("gone") and e.get("k") and e.get("pr")]
    cands.sort(key=lambda c: (-c["s"], c["kind"] != "sold"))
    pairs, seen = [], set()
    for c in cands:
        key = (norm(c["k"]), c.get("c"))
        if key in seen:
            continue
        seen.add(key)
        c["jp"] = find_same_in_japan(ctx, c, must_ja, exclude, q_ja)
        pairs.append(c)
        if len(pairs) >= MAX_PAIRS:
            break
    return pairs


def prune_jpmatch(state, today):
    cache = state.get("jpmatch", {})
    for k in [k for k, v in cache.items() if v["d"] < days_ago(today, 3)]:
        del cache[k]


# ---------------------------------------------------------------- 1商品の処理

def process_product(p, genre, ctx):
    ebay, tracker, fx = ctx["ebay"], ctx["tracker"], ctx["fx"]
    must_en = p.get("must", []) + p.get("must_en", [])
    must_ja = p.get("must", []) + p.get("must_ja", [])
    exclude_en = genre.get("exclude_en", []) + p.get("exclude", [])
    exclude_ja = genre.get("exclude_ja", []) + p.get("exclude", [])
    min_usd, min_jpy = p.get("min_usd", 0), p.get("min_jpy", 0)
    cond = p.get("cond", "any")
    out = {"id": p["id"], "g": p["g"], "name": p["name"], "q_en": p["q_en"], "q_ja": p["q_ja"],
           "img": None, "ebay": None, "jp": None, "etsy": None, "pairs": [], "match": None, "errors": []}

    # eBay: 価格と販売数
    try:
        listings = [listing_from_summary(s) for s in ebay.search(p["q_en"], min_usd, cond)
                    if title_ok(s.get("title"), must_en, exclude_en)]
        listings = [x for x in listings if x["p"] is not None and x["p"] >= min_usd]
        tracked = listings[:MAX_TRACK_PER_PRODUCT]
        details = ebay.details([x["id"] for x in tracked])
        for x in tracked:
            d = details.get(x["id"])
            if isinstance(d, dict):
                x["s"] = sold_quantity(d)
                x["k"], x["c"], x["b"] = model_of(x["t"], d), color_of(d), brand_of(d)
                ident = {"t": x["t"][:90], "u": x["u"], "k": x["k"], "c": x["c"], "b": x["b"]}
                tracker.observe(x["id"], x["s"], p["g"], p["id"], price=x["p"], seller=x.get("sl"), ident=ident)
        rechecked = recheck(ebay, tracker, lambda e: e.get("p") == p["id"], p["g"], p["id"])

        # 売れた記録を貯める（同じ日に再実行したら今日の分は入れ直す）
        mine = lambda e: e.get("p") == p["id"]  # noqa: E731
        sales = ctx["state"].setdefault("sales", {}).setdefault(p["id"], [])
        sales[:] = [e for e in sales if e[0] != ctx["today"] and e[0] > days_ago(ctx["today"], 60)]
        sales += tracker.sales_today(mine)
        liq = liquidity(sales, len(tracked), len({x["sl"] for x in listings if x.get("sl")}), ctx["today"])

        sold_prices = [x["p"] for x in tracked if x.get("s", 0) > 0]
        ask = median([x["p"] for x in listings])
        sold_med = median(sold_prices) if len(sold_prices) >= 3 else None
        # 売値の基準: 売れた記録が5件以上あればその中央値、次に複数個出品の価格、最後に出品価格
        if liq["cnt"] >= 5:
            sell, basis = liq["med"], "sold"
        elif sold_med:
            sell, basis = sold_med, "multi"
        else:
            sell, basis = ask, "ask"
        agg = tracker.summary(mine)
        top = sorted(tracked, key=lambda x: (-x.get("s", 0), x["p"]))[:5]
        out["img"] = next((x["i"] for x in top if x.get("i")), None)
        out["ebay"] = {
            "n": len(listings), "ask": ask, "sold_med": sold_med, "sell": sell, "basis": basis,
            "sold_total": sum(x.get("s", 0) for x in tracked),
            "s1": agg["s1"], "v1": agg["v1"], "liq": liq,
            "top": [{k: x.get(k) for k in ("t", "p", "s", "u", "i")} for x in top],
        }
        log(f"    eBay {len(listings)}件 / 売値 ${sell}（{basis}）/ 30日 {liq['s30']}個 / 本日販売 {agg['s1']} / 終了 {agg['v1']} (再確認 {rechecked})")

        # 売れた出品と同じ型番・色の品物を日本で探して、1組ずつ比べる
        if ctx["rakuten"] or ctx["yahoo"]:
            out["pairs"] = pair_with_japan(ctx, tracked, p["id"], must_ja, exclude_ja, p["q_ja"])
            matched = [x for x in out["pairs"] if x["jp"]]
            out["match"] = {"n": len(matched), "sell": median([x["p"] for x in matched]),
                            "buy": median([x["jp"]["p"] for x in matched])} if matched else None
            log(f"    型番一致 {len(matched)}/{len(out['pairs'])}組")
    except ApiError as e:
        out["errors"].append(f"eBay: {e}")
        log(f"    eBay 失敗: {e}")

    # 日本側: 楽天市場・Yahoo!ショッピング
    # eBay の売値の一定割合より安いものは、ケースや付属品など別の品物とみなして探さない
    floor = max(min_jpy, 1)
    if out["ebay"] and out["ebay"]["sell"]:
        floor = max(floor, round(out["ebay"]["sell"] * fx * ctx["settings"].get("jp_floor_ratio", 0.2)))
    items = []
    for name, client in (("楽天", ctx["rakuten"]), ("Yahoo!", ctx["yahoo"])):
        if not client:
            continue
        try:
            found = client.search(p["q_ja"], floor) if name == "楽天" else client.search(p["q_ja"], floor, cond)
            items += found
        except ApiError as e:
            out["errors"].append(f"{name}: {e}")
            log(f"    {name} 失敗: {e}")
    items = [x for x in items if x["p"] >= floor and title_ok(x["t"], must_ja, exclude_ja)]
    if items:
        prices = sorted(x["p"] for x in items)
        out["jp"] = {"n": len(items), "min": prices[0], "p25": round(quantile(prices, 0.25)),
                     "med": round(statistics.median(prices)),
                     "items": sorted(items, key=lambda x: x["p"])[:5]}
        log(f"    日本 {len(items)}件 / 下位25% ¥{out['jp']['p25']:,}")

    # Etsy（キーがある場合だけ）
    if ctx["etsy"]:
        try:
            found = [x for x in ctx["etsy"].search(p["q_en"], fx)
                     if x["p"] >= min_usd and title_ok(x["t"], must_en, exclude_en)]
            ids = [x["id"] for x in found]
            seen = ctx["state"].setdefault("etsy", {}).setdefault(p["id"], {"d": None, "ids": [], "prev": []})
            if seen["d"] != ctx["today"]:
                seen["prev"], seen["d"] = seen["ids"], ctx["today"]
            seen["ids"] = ids
            out["etsy"] = {"n": len(found), "med": median([x["p"] for x in found]),
                           "v1": len(set(seen["prev"]) - set(ids)) if seen["prev"] else 0}
        except ApiError as e:
            out["errors"].append(f"Etsy: {e}")
            log(f"    Etsy 失敗: {e}")
    return out


def process_discovery(genre, ctx):
    ebay, tracker = ctx["ebay"], ctx["tracker"]
    exclude = genre.get("exclude_en", [])
    candidates = {}
    for d in genre.get("discovery", []):
        try:
            found = [listing_from_summary(s) for s in ebay.search(d["q"], d.get("min_usd", 0))
                     if title_ok(s.get("title"), [], exclude)]
        except ApiError as e:
            log(f"    売れ筋「{d['q']}」失敗: {e}")
            continue
        found = [x for x in found if x["p"] is not None and x["p"] >= d.get("min_usd", 0)]
        for x in found[:MAX_TRACK_PER_QUERY]:
            candidates.setdefault(x["id"], {**x, "q": d["q"]})

    results = []
    for iid, detail in ebay.details(list(candidates)).items():
        if not isinstance(detail, dict):
            continue
        sold = sold_quantity(detail)
        known = iid in tracker.items
        if sold == 0 and not known:
            continue  # 売れていない出品は記録しない
        e = tracker.observe(iid, sold, genre["id"])
        if sold:
            results.append({**candidates[iid], "s": sold, "s1": tracker.delta(e)})
    recheck(ebay, tracker, lambda e: e["g"] == genre["id"] and not e.get("p"), genre["id"])

    results.sort(key=lambda x: (-x["s1"], -x["s"], x["p"]))
    for x in results:
        x.pop("id", None)
    log(f"    売れ筋 {len(candidates)}件中 販売実績あり {len(results)}件")
    return results[:DISCOVERY_TOP]


def process_etsy_discovery(genre, ctx):
    """Etsy の日本のショップの売れ筋。

    Etsy は出品ごとの販売数を公開していないので、在庫数が前日から減った分を「売れた数」、
    検索から消えて売り切れ・終了になっていたものを「終了した出品」として数える。
    items[listingId] = {g, qty: 最新の在庫, pqty: 前日終了時点の在庫, d: 最後に調べた日, seen, end, ended}
    """
    etsy, fx, today = ctx["etsy"], ctx["fx"], ctx["today"]
    items = ctx["state"].setdefault("etsy_items", {})
    gid = genre["id"]
    exclude = genre.get("exclude_en", [])

    def roll(e):
        if e["d"] != today:
            e["pqty"], e["d"] = e["qty"], today

    found = {}
    for d in genre.get("etsy_discovery", []):
        try:
            for x in etsy.search(d["q"], fx):
                if x["p"] >= d.get("min_usd", 0) and title_ok(x["t"], [], exclude):
                    found.setdefault(x["id"], {**x, "q": d["q"]})
        except ApiError as e:
            log(f"    Etsy「{d['q']}」失敗: {e}")

    for lid, x in found.items():
        e = items.get(lid)
        if e is None:
            e = items[lid] = {"g": gid, "qty": x["qty"], "pqty": None, "d": today, "fav0": x["fav"], "since": today}
        roll(e)
        e["qty"], e["seen"], e["fav"] = x["qty"], today, x["fav"]
        for k in ("end", "ended"):
            e.pop(k, None)

    # 昨日まで出ていたのに今日は出てこなかった出品が、売り切れたのか終わったのかを確かめる
    since = days_ago(today, RECHECK_DAYS)
    missing = [lid for lid, e in items.items()
               if e["g"] == gid and e.get("seen") != today and "end" not in e and e.get("seen", "") >= since]
    for lid in missing[:120]:
        e = items[lid]
        try:
            r = etsy.listing(lid)
        except ApiError as err:
            log(f"    Etsy 出品 {lid} 失敗: {err}")
            continue
        roll(e)
        if r is GONE:
            e["end"], e["ended"] = "gone", today
        elif isinstance(r, dict):
            if r.get("state") == "sold_out":
                e["end"], e["ended"], e["qty"] = "sold", today, 0
            elif r.get("state") != "active":
                e["end"], e["ended"] = "gone", today
            elif r.get("quantity") is not None:
                e["qty"] = r["quantity"]

    def sold_delta(e):
        if e["d"] != today or e["pqty"] is None or e["qty"] is None or e.get("end") == "gone":
            return 0
        return max(0, e["pqty"] - e["qty"])

    results = []
    for lid, x in found.items():
        e = items[lid]
        days = (date.fromisoformat(today) - date.fromisoformat(e.get("since", today))).days
        results.append({k: x[k] for k in ("t", "p", "qty", "fav", "u", "q")}
                       | {"s1": sold_delta(e), "favup": x["fav"] - e.get("fav0", x["fav"]), "days": days,
                          "shop_id": x.get("shop_id")})
    results.sort(key=lambda x: (-x["s1"], -x["favup"], -x["fav"], x["p"]))
    results = results[:DISCOVERY_TOP]

    # 上位の出品について、そのショップの累計販売数を足す（Etsy が公開している数字。1週間ごとに取り直す）
    shops = ctx["state"].setdefault("etsy_shops", {})
    for x in results:
        sid = str(x.pop("shop_id", "") or "")
        if not sid:
            continue
        cached = shops.get(sid)
        if not cached or cached["d"] < days_ago(today, 7):
            info = etsy.shop(sid)
            if info:
                shops[sid] = cached = {"d": today, **info}
        if cached:
            x["shop"] = {"name": cached.get("name"), "sold": cached.get("sold"), "url": cached.get("url")}

    mine = [e for e in items.values() if e["g"] == gid and e["d"] == today]
    summary = {"es1": sum(sold_delta(e) for e in mine),
               "ev1": sum(1 for e in mine if e.get("ended") == today and e.get("end") == "gone"),
               "en": len(found)}
    log(f"    Etsy 売れ筋 {len(found)}件 / 売れた {summary['es1']} / 終了 {summary['ev1']}")
    return results, summary


def prune_etsy(state, today):
    items = state.get("etsy_items", {})
    keep_since, ended_since = days_ago(today, STATE_KEEP_DAYS), days_ago(today, 2)
    for lid in [lid for lid, e in items.items() if e["d"] < keep_since or e.get("ended", "9999") < ended_since]:
        del items[lid]


# ---------------------------------------------------------------- 保存

def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path, obj, compact=True):
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, ensure_ascii=False, separators=(",", ":") if compact else None,
                      indent=None if compact else 1)
    path.write_text(text + "\n", encoding="utf-8")


def upsert(rows, row):
    rows[:] = [r for r in rows if r["d"] != row["d"]] + [row]
    rows.sort(key=lambda r: r["d"])
    del rows[:-HISTORY_DAYS]


def ebay_key_hint(client_id, secret):
    """キーの値は出さずに、どの種類のキーが入っているかだけを出す。"""
    def kind(v):
        if "-PRD-" in v or v.startswith("PRD-"):
            return "Production 用"
        if "-SBX-" in v or v.startswith("SBX-"):
            return "Sandbox 用"
        if re.fullmatch(r"[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", v):
            return "Dev ID と同じ形"
        return "見慣れない形"

    log(f"  EBAY_CLIENT_ID: {kind(client_id)}（{len(client_id)}文字）")
    log(f"  EBAY_CLIENT_SECRET: {kind(secret)}（{len(secret)}文字）")
    basic = base64.b64encode(f"{client_id}:{secret}".encode()).decode()
    body = urllib.parse.urlencode({"grant_type": "client_credentials",
                                   "scope": "https://api.ebay.com/oauth/api_scope"}).encode()
    try:
        http_json("https://api.sandbox.ebay.com/identity/v1/oauth2/token",
                  {"Authorization": f"Basic {basic}", "Content-Type": "application/x-www-form-urlencoded"},
                  data=body, retries=1)
        log("  Sandbox では認証が通りました → Production のキーに入れ替えてください")
    except ApiError as e:
        log(f"  Sandbox でも認証できません（HTTP {e.status}）")


def check_sources(ctx, fx):
    """eBay 以外のキーが通るかを1回ずつ試して結果だけ出す（キーの値は出さない）。"""
    tests = [
        ("楽天", ctx["rakuten"], lambda c: c.search("ニコン FM2", 0)),
        ("Yahoo!", ctx["yahoo"], lambda c: c.search("ニコン FM2", 0, "any")),
        ("Etsy", ctx["etsy"], lambda c: c.search("kokeshi", fx)),
    ]
    for name, client, run in tests:
        if not client:
            log(f"キー確認 {name}: 未設定")
            continue
        try:
            n = len(run(client))
            extra = f" 応答の項目: {client.last_keys}" if n == 0 and hasattr(client, "last_keys") else ""
            log(f"キー確認 {name}: OK（{n}件）{extra}")
        except ApiError as e:
            log(f"キー確認 {name}: NG {e}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", help="この商品IDだけ処理する")
    ap.add_argument("--no-discovery", action="store_true", help="売れ筋の検索を省く")
    ap.add_argument("--dry-run", action="store_true", help="ファイルに保存しない")
    ap.add_argument("--check", action="store_true", help="各 API のキーが通るかだけ確かめる")
    args = ap.parse_args()

    def env(key):
        # Secrets に貼るときに紛れ込んだ前後の空白・改行は取り除く
        return (os.environ.get(key) or "").strip() or None

    if not (env("EBAY_CLIENT_ID") and env("EBAY_CLIENT_SECRET")):
        log("EBAY_CLIENT_ID と EBAY_CLIENT_SECRET を設定してください（README の手順 1）。")
        return 2

    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    genres = {g["id"]: g for g in cfg["genres"]}
    products = [p for p in cfg["products"] if not args.only or p["id"] in args.only]
    today = datetime.now(JST).date().isoformat()
    state = load_json(STATE_PATH, {})

    fx, fx_source = fetch_fx(cfg["settings"].get("fx_fallback", 150))
    log(f"為替 1USD = {fx:.2f}円 ({fx_source})")

    ctx = {
        "today": today, "fx": fx, "state": state, "tracker": Tracker(state, today), "settings": cfg["settings"],
        "rakuten": Rakuten(env("RAKUTEN_APP_ID"), env("RAKUTEN_ACCESS_KEY"), env("RAKUTEN_REFERER"))
                   if env("RAKUTEN_APP_ID") and env("RAKUTEN_ACCESS_KEY") else None,
        "yahoo": YahooShopping(env("YAHOO_CLIENT_ID")) if env("YAHOO_CLIENT_ID") else None,
        "etsy": Etsy(env("ETSY_API_KEY")) if env("ETSY_API_KEY") else None,
    }
    try:
        ctx["ebay"] = Ebay(env("EBAY_CLIENT_ID"), env("EBAY_CLIENT_SECRET"))
        log("キー確認 eBay: OK")
    except ApiError as e:
        log(f"キー確認 eBay: NG {e}")
        if e.status in (400, 401):
            log("  → App ID と Cert ID の入れ違い、Sandbox 用のキー（-SBX-）、"
                "Production キーが無効（Marketplace Account Deletion 未設定）のどれかの可能性が高いです。")
            ebay_key_hint(env("EBAY_CLIENT_ID"), env("EBAY_CLIENT_SECRET"))
        check_sources(ctx, fx)
        return 1
    if args.check:
        check_sources(ctx, fx)
        return 0
    if not (ctx["rakuten"] or ctx["yahoo"]):
        log("注意: 楽天・Yahoo!のキーが無いため、日本側の価格は取得しません。")

    out_products = []
    for p in products:
        log(f"- {p['name']}")
        out_products.append(process_product(p, genres[p["g"]], ctx))
    if products and all(o["ebay"] is None for o in out_products):
        log("eBay の取得がすべて失敗したため、データを更新せずに終了します。")
        return 1

    discovery, etsy_discovery, etsy_summary = {}, {}, {}
    if not args.no_discovery and not args.only:
        for g in cfg["genres"]:
            log(f"- 売れ筋: {g['name']}")
            discovery[g["id"]] = process_discovery(g, ctx)
            if ctx["etsy"]:
                etsy_discovery[g["id"]], etsy_summary[g["id"]] = process_etsy_discovery(g, ctx)

    tracker = ctx["tracker"]
    log(f"API 呼び出し eBay {ctx['ebay'].calls} 回" + (f" / Etsy {ctx['etsy'].calls} 回" if ctx["etsy"] else ""))
    if args.dry_run:
        log(json.dumps(out_products, ensure_ascii=False, indent=1)[:4000])
        return 0

    history = load_json(DATA_DIR / "history.json", {})
    if history.get("demo"):
        history = {}  # デモデータは捨てて実データから数え直す
    for o in out_products:
        eb, jp, et = o["ebay"] or {}, o["jp"] or {}, o["etsy"] or {}
        rows = history.setdefault("products", {}).setdefault(o["id"], [])
        upsert(rows, {
            "d": today, "sell": eb.get("sell"), "ask": eb.get("ask"), "n": eb.get("n"),
            "s1": eb.get("s1"), "v1": eb.get("v1"), "jp": jp.get("p25"), "etsy": et.get("med")})
        if eb.get("liq"):
            eb["liq"]["days"] = len(rows)  # 何日分の記録から出した数字か
    if not args.only:
        for gid in genres:
            upsert(history.setdefault("genres", {}).setdefault(gid, []),
                   {"d": today, **tracker.summary(lambda e, gid=gid: e["g"] == gid), **etsy_summary.get(gid, {})})
    upsert(history.setdefault("fx", []), {"d": today, "v": round(fx, 2)})
    history["start"] = min(r["d"] for r in history["fx"])

    latest = load_json(DATA_DIR / "latest.json", {})
    if args.only and not latest.get("demo"):
        # 一部だけ更新したときは他の商品の結果を残す
        merged = {o["id"]: o for o in latest.get("products", [])}
        merged.update({o["id"]: o for o in out_products})
        order = [p["id"] for p in cfg["products"]]
        out_products = sorted(merged.values(), key=lambda o: order.index(o["id"]) if o["id"] in order else 999)
        discovery = latest.get("discovery", {})
        etsy_discovery = latest.get("etsy_discovery", {})

    write_json(DATA_DIR / "latest.json", {
        "generated_at": datetime.now(JST).isoformat(timespec="minutes"),
        "date": today,
        "demo": False,
        "fx": {"usdjpy": round(fx, 2), "source": fx_source},
        "settings": cfg["settings"],
        "genres": [{"id": g["id"], "name": g["name"]} for g in cfg["genres"]],
        "sources": {"ebay": True, "rakuten": bool(ctx["rakuten"]), "yahoo": bool(ctx["yahoo"]),
                    "etsy": bool(ctx["etsy"])},
        "products": out_products,
        "discovery": discovery,
        "etsy_discovery": etsy_discovery,
        "api_calls": {"ebay": ctx["ebay"].calls, "etsy": ctx["etsy"].calls if ctx["etsy"] else 0},
    })
    write_json(DATA_DIR / "history.json", history)
    tracker.prune()
    prune_etsy(state, today)
    prune_jpmatch(state, today)
    write_json(STATE_PATH, state)
    log("保存しました。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
