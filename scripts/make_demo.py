#!/usr/bin/env python3
"""画面確認用のデモデータを作る（APIキーが無くても見た目を確かめられる）。

作られるデータには "demo": true が付き、アプリ上部に「デモデータ」と表示される。
本物の取得（fetch.py）を一度でも実行すると上書きされる。
"""
import json
import random
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
cfg = json.loads((ROOT / "config" / "watchlist.json").read_text(encoding="utf-8"))
rng = random.Random(7)
JST = timezone(timedelta(hours=9))
today = datetime.now(JST).date()
DAYS = 45
fx = 155.0

DISCOVERY_TITLES = {
    "camera": ["Nikon F3 HP Body [Exc+5]", "Canon New FD 50mm f1.4 [Near Mint]", "Olympus XA2 Film Camera",
               "Minolta TC-1 Silver", "Pentax MX Black Body", "Yashica T4 Zoom"],
    "craft": ["Arita Imari Porcelain Plate Blue White", "Tetsubin Iwachu Cast Iron Kettle 1.2L",
              "Shigefusa Kitaeji Gyuto 240mm", "Mashiko Ware Vase Signed", "Wajima Lacquer Soup Bowl Set"],
    "hobby": ["Famicom Console AV Mod Tested", "Pokemon Card Japanese Charizard ex SAR", "Figma Link Twilight Princess",
              "Game Boy Pocket Clear Purple", "Sailor Moon Transformation Brooch 1992"],
    "fashion": ["Seiko 5 SNXS79 Automatic JDM", "Issey Miyake Homme Plisse Pants Size 3", "Vintage Silk Kimono Crane Pattern",
                "Grand Seiko SBGX261 Quartz", "Neighborhood Bomber Jacket M"],
}


def daily_series(sell, jp, base_sold):
    rows, s, j = [], sell * rng.uniform(0.9, 1.05), jp * rng.uniform(0.95, 1.1)
    for i in range(DAYS):
        d = (today - timedelta(days=DAYS - 1 - i)).isoformat()
        s *= rng.uniform(0.985, 1.018)
        j *= rng.uniform(0.98, 1.02)
        rows.append({"d": d, "sell": round(s, 2), "ask": round(s * 1.08, 2), "n": rng.randint(8, 60),
                     "s1": max(0, int(rng.gauss(base_sold, base_sold * 0.8))) if i else 0,
                     "v1": max(0, int(rng.gauss(base_sold * 0.6, 1))) if i else 0, "jp": round(j), "etsy": None})
    rows[-1]["sell"], rows[-1]["jp"] = sell, jp
    return rows


products, hist_products = [], {}
for p in cfg["products"]:
    sell = round(p["min_usd"] * rng.uniform(1.8, 3.4), 2)
    jp = round(sell * fx * rng.uniform(0.3, 0.85) / 100) * 100
    base_sold = rng.choice([0.2, 0.5, 1, 1.5, 3])
    rows = daily_series(sell, jp, base_sold)
    hist_products[p["id"]] = rows
    products.append({
        "id": p["id"], "g": p["g"], "name": p["name"], "q_en": p["q_en"], "q_ja": p["q_ja"], "img": None,
        "ebay": {"n": rows[-1]["n"], "ask": round(sell * 1.08, 2), "sold_med": sell, "sell": sell,
                 "sold_total": rng.randint(3, 80), "s1": rows[-1]["s1"], "v1": rows[-1]["v1"],
                 "top": [{"t": f"[デモ] {p['q_en']} listing {k + 1}", "p": round(sell * rng.uniform(0.85, 1.2), 2),
                          "s": rng.randint(0, 12), "u": f"https://www.ebay.com/sch/i.html?_nkw={p['q_en']}", "i": None}
                         for k in range(4)]},
        "jp": {"n": rng.randint(4, 40), "min": round(jp * 0.8), "p25": jp, "med": round(jp * 1.3),
               "items": [{"t": f"[デモ] {p['q_ja']} 商品{k + 1}", "p": round(jp * (0.8 + k * 0.15)),
                          "u": "https://search.rakuten.co.jp/", "i": None, "shop": "デモショップ",
                          "src": "楽天" if k % 2 else "Yahoo!"} for k in range(3)]},
        "etsy": None, "errors": [],
    })

discovery, hist_genres = {}, {}
for g in cfg["genres"]:
    discovery[g["id"]] = sorted([
        {"t": f"[デモ] {t}", "p": round(rng.uniform(40, 600), 2), "s": rng.randint(1, 40), "s1": rng.choice([0, 0, 1, 2, 3]),
         "u": f"https://www.ebay.com/sch/i.html?_nkw={t}", "i": None, "q": g["discovery"][0]["q"]}
        for t in DISCOVERY_TITLES[g["id"]]], key=lambda x: (-x["s1"], -x["s"]))
    hist_genres[g["id"]] = [
        {"d": (today - timedelta(days=DAYS - 1 - i)).isoformat(),
         "s1": max(0, int(rng.gauss(9, 4))) if i else 0, "v1": max(0, int(rng.gauss(5, 3))) if i else 0,
         "n": rng.randint(150, 260)} for i in range(DAYS)]

fx_rows = [{"d": (today - timedelta(days=DAYS - 1 - i)).isoformat(), "v": round(fx + rng.uniform(-3, 3), 2)}
           for i in range(DAYS)]
fx_rows[-1]["v"] = fx

out = ROOT / "docs" / "data"
out.mkdir(parents=True, exist_ok=True)
(out / "latest.json").write_text(json.dumps({
    "generated_at": datetime.now(JST).isoformat(timespec="minutes"), "date": today.isoformat(), "demo": True,
    "fx": {"usdjpy": fx, "source": "demo"}, "settings": cfg["settings"],
    "genres": [{"id": g["id"], "name": g["name"]} for g in cfg["genres"]],
    "sources": {"ebay": True, "rakuten": True, "yahoo": True, "etsy": False},
    "products": products, "discovery": discovery, "api_calls": {"ebay": 0},
}, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
(out / "history.json").write_text(json.dumps({
    "demo": True, "start": fx_rows[0]["d"], "products": hist_products, "genres": hist_genres, "fx": fx_rows,
}, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
print("デモデータを書き出しました:", out)
