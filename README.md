# 越境ウォッチ

eBay で売れている日本の品物（日本から発送されている出品）の相場と販売数を毎朝集め、
楽天市場・Yahoo!ショッピングの仕入れ値と比べて「利益が出そうな商品」を iPhone で見られるようにするツール。
App Store は使わず、Safari の「ホーム画面に追加」でアプリのように使う（PWA）。

```
毎朝 6:00 (GitHub Actions)
  scripts/fetch.py
    ├─ eBay Browse API     日本発送の出品の価格・累計販売数
    ├─ 楽天市場 API         仕入れ値
    ├─ Yahoo!ショッピング API 仕入れ値
    └─ Etsy API（任意）     日本のショップの価格
  → docs/data/*.json を保存
GitHub Pages (docs/) → iPhone の Safari で開く
```

メルカリとヤフオクは公開 API が無く、規約上も自動取得できないので、
詳細画面に「売り切れ一覧」「落札相場」を開くボタンを付けてある。

## はじめの設定

### 1. eBay の API キー（必須）

1. https://developer.ebay.com/ で開発者アカウントを作る
2. 「Application Keys」で **Production** のキーセットを作る
   - 途中で「Marketplace Account Deletion」の設定を求められたら、
     eBay の利用者情報を保存しないアプリとして **適用除外（exemption）** を選ぶ
3. **App ID (Client ID)** と **Cert ID (Client Secret)** を控える

### 2. 楽天・Yahoo! の API キー（どちらか一方でも可）

- 楽天: https://webservice.rakuten.co.jp/ でアプリを登録し、**アプリID** と **アクセスキー** を控える
- Yahoo!: https://e.developer.yahoo.co.jp/register でアプリを登録し、**Client ID** を控える

### 3. GitHub に置く

1. このフォルダを GitHub のリポジトリに push する
2. リポジトリの **Settings → Secrets and variables → Actions** で次を登録する

   | 名前 | 中身 |
   |---|---|
   | `EBAY_CLIENT_ID` | eBay の App ID |
   | `EBAY_CLIENT_SECRET` | eBay の Cert ID |
   | `RAKUTEN_APP_ID` | 楽天のアプリID |
   | `RAKUTEN_ACCESS_KEY` | 楽天のアクセスキー |
   | `YAHOO_CLIENT_ID` | Yahoo! の Client ID |
   | `ETSY_API_KEY` | （任意）Etsy の `keystring:shared_secret` |
   | `RAKUTEN_REFERER` | （任意）楽天アプリに許可サイトを登録した場合、その URL |

3. **Settings → Pages** で「Deploy from a branch」→ `main` / `/docs` を選ぶ
4. **Actions → daily-fetch → Run workflow** で1回手動実行する（10分ほど）
5. 以後は毎朝 6:00 に自動で更新される

### 4. iPhone に置く

1. Safari で `https://<GitHubのユーザー名>.github.io/<リポジトリ名>/` を開く
2. 共有ボタン → 「ホーム画面に追加」

## 監視する商品を変える

`config/watchlist.json` の `products` を編集する（アプリの「設定」タブから GitHub の編集画面を開ける）。

| 項目 | 意味 |
|---|---|
| `q_en` | eBay で検索する言葉 |
| `q_ja` | 楽天・Yahoo!・メルカリ・ヤフオクで検索する言葉 |
| `must` / `must_en` / `must_ja` | タイトルに必ず含まれるべき語（型番など）。空白・ハイフン・全角半角の違いは無視 |
| `exclude` | 除外する語（ジャンル共通の除外語に追加される） |
| `cond` | `used` / `new` / `any` |
| `min_usd` / `min_jpy` | これより安いものは付属品などとして無視 |

売れ筋タブの検索語はジャンルごとの `discovery` で変えられる。

## 数字の決め方

- **eBay 相場**: 日本発送の出品の「価格＋アメリカ向け送料」の中央値。販売実績のある出品が3件以上あればそちらの中央値
- **売れた数**: 出品ごとの累計販売数（eBay の `estimatedSoldQuantity`）を毎日記録し、前日から増えた分
- **終了した出品**: 前日まで検索に出ていた出品が終了していたもの（売れた可能性が高い）
- **仕入れ目安**: 楽天・Yahoo! で見つかった価格の安い方から25%の位置
- **見込み利益**: 売値 − eBay手数料 − 為替手数料 − 国際送料 − 仕入れ値 − 国内送料。
  手数料率や送料はアプリの「設定」タブで端末ごとに変えられる

どれも目安。状態・付属品・真贋・実際の送料・アメリカの関税は品物ごとに違うので、仕入れる前にリンク先で確かめること。

## 手元で動かす

```bash
python scripts/make_demo.py      # 画面確認用のデモデータ
python -m http.server 8765 --directory docs
```

```bash
EBAY_CLIENT_ID=... EBAY_CLIENT_SECRET=... python scripts/fetch.py --only nikon-fm2 --dry-run
```

標準ライブラリだけで動くので `pip install` は不要。

## 注意

- GitHub の無料プランでは、Pages で公開したページと監視リストは URL を知っている人なら見られる（API キーは Secrets に入れるので公開されない）
- eBay Browse API は1日5,000回まで。初期設定の監視リスト（30商品＋売れ筋）で1日1,500〜2,500回程度
