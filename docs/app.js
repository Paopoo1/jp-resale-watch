'use strict';

/* ================================================================ 状態 */

// 表示の好みだけを端末に保存する（保存できない環境でも動く）
const store = {
  get(k) { try { return localStorage.getItem('ekkyo-' + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('ekkyo-' + k, v); } catch { /* noop */ } },
  del(k) { try { localStorage.removeItem('ekkyo-' + k); } catch { /* noop */ } },
};

const app = {
  data: null,
  history: null,
  tab: store.get('tab') || 'profit',
  genre: store.get('genre') || 'all',
  sort: store.get('sort') || 'profit',
  onlyProfit: store.get('onlyProfit') !== 'false',
  hotSource: store.get('hotSource') || 'ebay',
  showAll: false,
  settings: null,
  charts: [],       // 画面のグラフ（リサイズ時に描き直す）
  sheetCharts: [],  // 詳細シートのグラフ
};

const view = document.getElementById('view');
const sheet = document.getElementById('sheet');

/* ================================================================ 書式 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => Math.round(v).toLocaleString('ja-JP');
const yen = (v) => (v == null ? '—' : (v < 0 ? '−¥' : '¥') + num(Math.abs(v)));
const signedYen = (v) => (v == null ? '—' : (v >= 0 ? '+¥' : '−¥') + num(Math.abs(v)));
const usd = (v) => (v == null ? '—' : '$' + (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2)));
const pct = (v) => (v == null ? '—' : Math.round(v * 100) + '%');
const md = (d) => { const [, m, dd] = d.split('-'); return `${+m}/${+dd}`; };
const man = (v) => (Math.abs(v) >= 10000 ? `${+(v / 10000).toFixed(1)}万` : num(v));
const todayJst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const enc = encodeURIComponent;

/* ================================================================ データ */

async function getJSON(url) {
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

async function load() {
  const btn = document.getElementById('reload');
  btn.classList.add('spin');
  try {
    const [latest, history] = await Promise.all([
      getJSON('data/latest.json'),
      getJSON('data/history.json').catch(() => ({})),
    ]);
    app.data = latest;
    app.history = history;
    app.settings = mergeSettings(latest.settings);
    renderMeta();
    renderGenres();
    render();
    openFromHash();
  } catch (e) {
    view.innerHTML = `<div class="empty">データを読み込めませんでした。<br><small>${esc(e.message)}</small></div>`;
  } finally {
    btn.classList.remove('spin');
  }
}

function mergeSettings(defaults) {
  let saved = {};
  try { saved = JSON.parse(store.get('settings') || '{}'); } catch { saved = {}; }
  return {
    ...defaults,
    ...saved,
    ship_jpy: { ...defaults.ship_jpy, ...(saved.ship_jpy || {}) },
    fx_override: saved.fx_override ?? null,
  };
}

function saveSettings() {
  const d = app.data.settings, s = app.settings, diff = {};
  for (const k of ['fee_rate', 'fixed_fee_usd', 'fx_loss_rate', 'other_cost_rate', 'domestic_ship_jpy']) {
    if (s[k] !== d[k]) diff[k] = s[k];
  }
  const ship = Object.fromEntries(Object.entries(s.ship_jpy).filter(([g, v]) => v !== d.ship_jpy[g]));
  if (Object.keys(ship).length) diff.ship_jpy = ship;
  if (s.fx_override) diff.fx_override = s.fx_override;
  store.set('settings', JSON.stringify(diff));
}

const genreName = (id) => app.data.genres.find((g) => g.id === id)?.name ?? id;
const inGenre = (g) => app.genre === 'all' || app.genre === g;
const fxRate = () => (app.settings.fx_override > 0 ? app.settings.fx_override : app.data.fx.usdjpy);
const histOf = (id) => app.history?.products?.[id] || [];
const trackedDays = () => app.history?.fx?.length || 0;
// 7日の販売数（複数個出品の販売＋終了した出品）。流動性の記録があればそちらを使う
const sold7 = (id) => {
  const liq = app.data.products.find((p) => p.id === id)?.ebay?.liq;
  return liq ? liq.s7 : histOf(id).slice(-7).reduce((a, r) => a + (r.s1 || 0) + (r.v1 || 0), 0);
};

/** 流動性の目安。7日分たまるまでは「データ不足」。 */
function liqRating(p) {
  const l = p.ebay?.liq;
  if (!l || (l.days ?? 0) < 7) return { key: 'wait', label: 'データ不足', note: `計測${l?.days ?? 0}日目・7日で判定` };
  if ((l.str ?? 0) >= 0.5 || l.s30 >= 20) return { key: 'hot', label: 'よく売れる' };
  if ((l.str ?? 0) >= 0.2 || l.s30 >= 5) return { key: 'ok', label: '普通' };
  return { key: 'slow', label: '動きが遅い' };
}
const liqBadge = (p) => { const r = liqRating(p); return `<span class="liq liq-${r.key}" title="${esc(r.note || '')}">${r.label}</span>`; };
const LIQ_ORDER = { hot: 3, ok: 2, wait: 1, slow: 0 };

/** 一覧のカードに並べる流動性の数字。 */
function liqStrip(p) {
  const l = p.ebay?.liq;
  if (!l) return '';
  const cell = (label, value) => `<div><span>${label}</span><b>${value}</b></div>`;
  return `<div class="liq-strip">
    ${cell('30日で売れた', `${l.s30}個`)}
    ${cell('売れる率', l.str != null && l.s30 ? pct(l.str) : '—')}
    ${cell('はける日数', l.dos != null ? `${l.dos}日` : '—')}
    ${cell('売れた日', `${l.d14}/14日`)}
    ${cell('売れた値段', l.med != null ? usd(l.med) : '—')}
    ${cell('売り手', `${l.sellers}人`)}
  </div>`;
}

/** 1商品の利益計算。すべて「eBay で1個売ったら」の見込み。 */
function calc(p) {
  // 同じ型番で比べた組があれば、その中央値（eBay で売れた値段と日本の同じ品物の最安）で計算する
  const m = p.match;
  const r = calcCore(m ? m.sell : p.ebay?.sell, m ? m.buy : (p.jp?.p25 ?? null), p.g);
  if (r) r.basis = m ? 'match' : 'generic';
  return r;
}

/** eBay の売値(USD)と日本の仕入れ値(円)から、1個売ったときの利益を出す。 */
function calcCore(sell, buy, genre) {
  const S = app.settings, fx = fxRate();
  if (sell == null) return null;
  const fee = sell * S.fee_rate + S.fixed_fee_usd;
  const other = sell * S.other_cost_rate;
  const net = sell - fee - other;
  const r = {
    sell, fx, fee, other,
    salesJpy: sell * fx,
    feeJpy: fee * fx,
    otherJpy: other * fx,
    fxLossJpy: net * fx * S.fx_loss_rate,
    receivedJpy: net * fx * (1 - S.fx_loss_rate),
    ship: S.ship_jpy[genre] ?? 3000,
    domestic: S.domestic_ship_jpy,
    buy,
    profit: null,
    margin: null,
  };
  if (r.buy != null) {
    r.profit = r.receivedJpy - r.ship - r.buy - r.domestic;
    r.margin = r.profit / r.salesJpy;
  }
  return r;
}

/** 日本で今買える出品（どれも「販売中・安い順」で開く）。 */
const buyLinks = (q) => [
  { short: 'メルカリ', name: 'メルカリ', sub: '販売中・安い順', url: `https://jp.mercari.com/search?keyword=${enc(q)}&status=on_sale&sort=price&order=asc` },
  { short: 'ヤフオク', name: 'ヤフオク', sub: '出品中・安い順', url: `https://auctions.yahoo.co.jp/search/search?p=${enc(q)}&s1=cbids&o1=a` },
  { short: 'ラクマ', name: 'ラクマ', sub: '販売中・安い順', url: `https://fril.jp/s?query=${enc(q)}&transaction=selling&sort=sell_price&order=asc` },
  { short: 'Yフリマ', name: 'Yahoo!フリマ', sub: '販売中・安い順', url: `https://paypayfleamarket.yahoo.co.jp/search/${enc(q)}?open=1&sort=price&order=asc` },
];

/** 売れた価格を確かめるページ。 */
const soldLinks = (qEn, qJa) => [
  { short: 'メルカリ売切', name: 'メルカリ', sub: '売り切れ', url: `https://jp.mercari.com/search?keyword=${enc(qJa)}&status=sold_out` },
  { short: 'ヤフオク落札', name: 'ヤフオク', sub: '落札相場', url: `https://auctions.yahoo.co.jp/closedsearch/closedsearch?p=${enc(qJa)}` },
  { short: 'eBay落札', name: 'eBay', sub: '売れた出品', url: `https://www.ebay.com/sch/i.html?_nkw=${enc(qEn)}&LH_Sold=1&LH_Complete=1` },
  { short: 'Etsy', name: 'Etsy', sub: '出品中', url: `https://www.etsy.com/search?q=${enc(qEn)}` },
  { short: 'Terapeak', name: 'Terapeak', sub: 'eBay の販売履歴（要ログイン）', url: `https://www.ebay.com/sh/research?marketplace=EBAY-US&tabName=SOLD&keywords=${enc(qEn)}` },
];

const linkButtons = (links) => links.map((l) => `<a class="link" href="${esc(l.url)}" title="${esc(l.name)}（${esc(l.sub)}）" target="_blank" rel="noopener">${esc(l.short)}</a>`).join('');
const gridLink = (l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.name)}<span>${esc(l.sub)}</span></a>`;
const linkRow = (label, links) => `<div class="links"><span class="links-label">${label}</span>${linkButtons(links)}</div>`;

// 英語のタイトルを日本のサイトで探しやすい言葉に置き換える
const JA_WORDS = [
  [/\bsake cups?\b|\bguinomi\b/gi, 'ぐい呑み'], [/\btea bowl\b|\bchawan\b/gi, '茶碗'], [/\bfilm camera\b/gi, 'フィルムカメラ'],
  [/\bcast iron kettle\b|\btetsubin\b/gi, '鉄瓶'], [/\bkimono\b/gi, '着物'], [/\bhaori\b/gi, '羽織'], [/\bobi\b/gi, '帯'],
  [/\byukata\b/gi, '浴衣'], [/\bkokeshi\b/gi, 'こけし'], [/\bkyusu\b|\bteapot\b/gi, '急須'], [/\bfuroshiki\b/gi, '風呂敷'],
  [/\btenugui\b/gi, '手ぬぐい'], [/\bnetsuke\b/gi, '根付'], [/\blacquer(ware)?\b|\burushi\b/gi, '漆器'],
  [/\bpottery\b|\bceramics?\b/gi, '陶器'], [/\bporcelain\b/gi, '磁器'], [/\bimari\b/gi, '伊万里'], [/\barita\b/gi, '有田焼'],
  [/\bkutani\b/gi, '九谷焼'], [/\bbizen\b/gi, '備前焼'], [/\bhagi\b/gi, '萩焼'], [/\bmashiko\b/gi, '益子焼'],
  [/\bkitchen knife\b|\bknife\b/gi, '包丁'], [/\bfigure\b/gi, 'フィギュア'], [/\bsilk\b/gi, '正絹'],
];
const NOISE = /\b(from japan|made in japan|japanese|japan|jpn|jp|jdm|vintage|antique|authentic|handmade|traditional|exc|excellent|near|mint|n mint|nm|tested|working|very good|good|rare|f\/s|free shipping|fast shipping|w\/|with|new|used|condition|boxed|w box|top|gift|for (him|her)|women'?s|men'?s|and|the|of|for|a)\b/gi;

function jaQuery(title, translate = true) {
  let s = String(title || '').split(/,|\s[-–|]\s|\s\/\s/)[0]
    .replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】|「[^」]*」/g, ' ')
    .replace(/#\d+/g, ' ');
  if (translate) for (const [re, ja] of JA_WORDS) s = s.replace(re, ` ${ja} `);
  s = s.replace(NOISE, ' ').replace(/[★☆◆◇●○♪!！|+*]+/g, ' ').replace(/\s+/g, ' ').trim();
  let words = s.split(' ').filter(Boolean);
  if (translate && words.some((w) => /[^\x00-\x7F]/.test(w))) {
    // 日本語に置き換えられた語があれば、それと型番（数字入り）だけで探す
    words = words.filter((w) => /[^\x00-\x7F]/.test(w) || /\d/.test(w));
    if (words.some((w) => ['羽織', '帯', '浴衣'].includes(w))) words = words.filter((w) => w !== '着物');
  }
  return [...new Set(words)].slice(0, 4).join(' ') || String(title || '').split(' ').slice(0, 3).join(' ');
}

/* ================================================================ 共通部品 */

function thumb(src, label) {
  if (src) return `<img class="thumb" src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-label="${esc(label)}">`;
  return `<div class="thumb" aria-hidden="true">${esc([...(label || '?').replace(/^\[デモ\]\s*/, '')][0])}</div>`;
}

document.addEventListener('error', (e) => {
  const img = e.target;
  if (img instanceof HTMLImageElement && img.classList.contains('thumb')) {
    img.outerHTML = thumb(null, img.dataset.label);
  }
}, true);

function spark(values) {
  if (values.length < 2) return '';
  const w = 70, hgt = 20, n = values.length, bw = w / n, max = Math.max(1, ...values);
  const bars = values.map((v, i) => {
    const bh = v ? Math.max(2, (v / max) * hgt) : 1;
    const color = i === n - 1 ? 'var(--ebay)' : 'var(--spark)';
    return `<rect x="${(i * bw + 0.5).toFixed(1)}" y="${(hgt - bh).toFixed(1)}" width="${Math.max(1, bw - 1.5).toFixed(1)}" height="${bh.toFixed(1)}" rx="1" style="fill:${color}"/>`;
  }).join('');
  return `<svg class="spark" width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}" aria-hidden="true">${bars}</svg>`;
}

function demoBanner() {
  if (app.data.demo) {
    return `<div class="banner"><strong>デモデータです。</strong>数字は画面確認用の架空の値です。APIキーを設定して初回の取得が終わると、本物の数字に切り替わります。</div>`;
  }
  if (trackedDays() < 2) {
    return `<div class="banner">計測1日目です。「売れた数」は前日との差で数えるので、明日から表示されます。</div>`;
  }
  return '';
}

function renderMeta() {
  const t = new Date(app.data.generated_at);
  const time = `${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  document.getElementById('meta').innerHTML = `${time} 更新<br>1ドル = ${fxRate().toFixed(1)}円`;
}

function renderGenres() {
  const box = document.getElementById('genres');
  const items = [{ id: 'all', name: 'すべて' }, ...app.data.genres];
  box.innerHTML = items.map((g) => `<button class="chip" data-genre="${g.id}" aria-pressed="${app.genre === g.id}">${esc(g.name)}</button>`).join('');
  box.hidden = app.tab === 'settings';
}

/* ================================================================ グラフ */

function niceTicks(min, max, count = 4, integer = false) {
  if (min === max) { const d = Math.abs(min) * 0.1 || 1; min -= d; max += d; }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  let step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  if (integer) step = Math.max(1, Math.round(step));
  const ticks = [];
  for (let v = Math.floor(min / step) * step; v <= Math.ceil(max / step) * step + step / 2; v += step) ticks.push(+v.toFixed(8));
  return ticks;
}

function placeTip(el, tip, x, y) {
  tip.style.left = '0px';
  tip.style.top = `${y}px`;
  const w = tip.offsetWidth, W = el.clientWidth;
  tip.style.left = `${Math.min(Math.max(x, w / 2), W - w / 2)}px`;
}

function mountChart(el, draw, list = app.charts) {
  const run = () => draw(el);
  run();
  list.push(run);
}

/** 折れ線（同じ単位のシリーズだけを重ねる。軸は1本）。 */
function lineChart(el, { series, fmt, axisFmt = fmt, height = 180 }) {
  const dates = [...new Set(series.flatMap((s) => s.rows.map((r) => r.d)))].sort();
  const vals = series.map((s) => { const m = new Map(s.rows.map((r) => [r.d, r.v])); return dates.map((d) => m.get(d) ?? null); });
  const all = vals.flat().filter((v) => v != null);
  if (!all.length) { el.innerHTML = '<p class="note">まだデータがありません。</p>'; return; }

  const W = el.clientWidth || 320, H = height, L = 46, R = 64, T = 10, B = 22;
  const pw = W - L - R, ph = H - T - B, n = dates.length;
  const ticks = niceTicks(Math.min(...all), Math.max(...all), 4);
  const t0 = ticks[0], t1 = ticks[ticks.length - 1];
  const x = (i) => L + (n === 1 ? pw / 2 : (i * pw) / (n - 1));
  const y = (v) => T + (1 - (v - t0) / (t1 - t0 || 1)) * ph;

  let svg = '';
  for (const t of ticks) svg += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" style="stroke:var(--grid)"/><text x="${L - 6}" y="${y(t) + 3.5}" text-anchor="end">${esc(axisFmt(t))}</text>`;
  const xl = n > 6 ? [0, Math.floor((n - 1) / 2), n - 1] : n > 1 ? [0, n - 1] : [0];
  for (const i of xl) svg += `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'}">${md(dates[i])}</text>`;

  const ends = [];
  series.forEach((s, si) => {
    let d = '', pen = false;
    vals[si].forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    svg += `<path d="${d}" style="fill:none;stroke:${s.color};stroke-width:2;stroke-linejoin:round;stroke-linecap:round"/>`;
    const li = vals[si].map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0).pop();
    if (li != null) {
      svg += `<circle cx="${x(li)}" cy="${y(vals[si][li])}" r="4" style="fill:${s.color};stroke:var(--surface);stroke-width:2"/>`;
      ends.push({ y: y(vals[si][li]), x: x(li), text: fmt(vals[si][li]) });
    }
  });
  // 端の値ラベルは重ならないときだけ付ける（重なるなら凡例とタップで読む）
  const collide = ends.some((a, i) => ends.some((b, j) => i < j && Math.abs(a.y - b.y) < 14));
  if (!collide) for (const e of ends) svg += `<text class="end-label" x="${e.x + 8}" y="${e.y + 4}">${esc(e.text)}</text>`;

  el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="${esc(series.map((s) => s.name).join('と'))}の推移">${svg}<g class="hover"></g><rect class="hit" x="${L}" y="${T}" width="${pw}" height="${ph}" style="fill:transparent"/></svg><div class="tip" hidden></div>`;
  const hover = el.querySelector('.hover'), tip = el.querySelector('.tip'), hit = el.querySelector('.hit');

  const show = (ev) => {
    const r = el.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.round(((ev.clientX - r.left - L) / (pw || 1)) * (n - 1))));
    let g = `<line x1="${x(i)}" x2="${x(i)}" y1="${T}" y2="${T + ph}" style="stroke:var(--axis)"/>`;
    let top = T + ph, rows = '';
    series.forEach((s, si) => {
      const v = vals[si][i];
      if (v == null) return;
      g += `<circle cx="${x(i)}" cy="${y(v)}" r="4" style="fill:${s.color};stroke:var(--surface);stroke-width:2"/>`;
      top = Math.min(top, y(v));
      rows += `<div><span class="dot" style="background:${s.color}"></span>${esc(s.name)} ${esc(fmt(v))}</div>`;
    });
    hover.innerHTML = g;
    tip.innerHTML = `<div>${md(dates[i])}</div>${rows || '<div>データなし</div>'}`;
    tip.hidden = false;
    placeTip(el, tip, x(i), top);
  };
  const hide = () => { hover.innerHTML = ''; tip.hidden = true; };
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', hide);
}

/** 積み上げ棒（日別の件数）。 */
function barChart(el, { rows, stacks, height = 150 }) {
  if (!rows.length) { el.innerHTML = '<p class="note">まだデータがありません。</p>'; return; }
  const W = el.clientWidth || 320, H = height, L = 30, R = 6, T = 10, B = 22;
  const pw = W - L - R, ph = H - T - B, n = rows.length, band = pw / n;
  const bw = Math.min(24, Math.max(2, band - 2));
  const totals = rows.map((r) => stacks.reduce((a, s) => a + (r[s.key] || 0), 0));
  const ticks = niceTicks(0, Math.max(1, ...totals), 3, true);
  const tmax = ticks[ticks.length - 1];
  const y = (v) => T + ph - (v / tmax) * ph;

  let svg = '';
  for (const t of ticks) svg += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" style="stroke:${t === 0 ? 'var(--axis)' : 'var(--grid)'}"/><text x="${L - 6}" y="${y(t) + 3.5}" text-anchor="end">${t}</text>`;
  rows.forEach((row, i) => {
    const bx = L + i * band + (band - bw) / 2;
    let base = y(0);
    const segs = stacks.map((s) => ({ s, v: row[s.key] || 0 })).filter((q) => q.v > 0);
    segs.forEach((q, k) => {
      let top = y(0) - ((totals[i] - segs.slice(k + 1).reduce((a, z) => a + z.v, 0)) / tmax) * ph;
      let bottom = base;
      if (k > 0) bottom -= 2; // 2px の隙間
      if (bottom - top < 1) top = bottom - 1;
      const isTop = k === segs.length - 1;
      const r = isTop ? Math.min(4, bw / 2, bottom - top) : 0;
      svg += `<path d="M${bx},${bottom}V${top + r}Q${bx},${top} ${bx + r},${top}H${bx + bw - r}Q${bx + bw},${top} ${bx + bw},${top + r}V${bottom}Z" style="fill:${q.s.color}"/>`;
      base = top;
    });
  });
  const xl = n > 6 ? [0, Math.floor((n - 1) / 2), n - 1] : n > 1 ? [0, n - 1] : [0];
  for (const i of xl) svg += `<text x="${L + i * band + band / 2}" y="${H - 6}" text-anchor="${i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'}">${md(rows[i].d)}</text>`;

  el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="日別の件数">${svg}<g class="hover"></g><rect class="hit" x="${L}" y="${T}" width="${pw}" height="${ph}" style="fill:transparent"/></svg><div class="tip" hidden></div>`;
  const hover = el.querySelector('.hover'), tip = el.querySelector('.tip'), hit = el.querySelector('.hit');
  const show = (ev) => {
    const rect = el.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.floor((ev.clientX - rect.left - L) / band)));
    hover.innerHTML = `<rect x="${L + i * band}" y="${T}" width="${band}" height="${ph}" style="fill:var(--ink);opacity:.06"/>`;
    tip.innerHTML = `<div>${md(rows[i].d)}</div>` + stacks.map((s) => `<div><span class="dot" style="background:${s.color}"></span>${esc(s.name)} ${rows[i][s.key] || 0}</div>`).join('');
    tip.hidden = false;
    placeTip(el, tip, L + i * band + band / 2, y(totals[i]));
  };
  const hide = () => { hover.innerHTML = ''; tip.hidden = true; };
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', hide);
}

function legend(items, square = false) {
  return `<div class="legend">${items.map((i) => `<span><span class="key${square ? ' sq' : ''}" style="background:${i.color}"></span>${esc(i.name)}</span>`).join('')}</div>`;
}

function dataTable(head, rows) {
  return `<details class="table"><summary>表で見る</summary><table class="data-table"><thead><tr>${head.map((x) => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></details>`;
}

/* ================================================================ 画面: 利益候補 */

function renderProfit() {
  const items = app.data.products.filter((p) => inGenre(p.g)).map((p) => ({ p, c: calc(p), s7: sold7(p.id) }));
  const good = items.filter((x) => x.c?.profit > 0);
  const soldYesterday = items.reduce((a, x) => a + (x.p.ebay?.s1 || 0), 0);

  const key = {
    profit: (x) => x.c?.profit ?? -Infinity,
    margin: (x) => x.c?.margin ?? -Infinity,
    sales: (x) => LIQ_ORDER[liqRating(x.p).key] * 1e12 + (x.p.ebay?.liq?.s30 ?? x.s7) * 1e7 + (x.p.ebay?.sold_total || 0) * 1e3 + (x.c?.profit ?? -1e6) / 1e3,
  }[app.sort];
  items.sort((a, b) => key(b) - key(a));
  const shown = app.onlyProfit && !app.showAll ? items.filter((x) => x.c?.profit > 0) : items;
  const hidden = items.length - shown.length;

  view.innerHTML = `
    ${demoBanner()}
    <div class="tiles">
      <div class="tile"><div class="label">黒字の商品</div><div class="value">${good.length}<small style="font-size:13px;font-weight:500"> / ${items.length}</small></div><div class="sub">件</div></div>
      <div class="tile"><div class="label">昨日の販売</div><div class="value">${soldYesterday}<small style="font-size:13px;font-weight:500">個</small></div><div class="sub">eBay・監視中</div></div>
      <div class="tile"><div class="label">最大の利益</div><div class="value ${good.length ? 'pos' : ''}">${good.length ? man(Math.max(...good.map((x) => x.c.profit))) : '—'}</div><div class="sub">円 / 1個</div></div>
    </div>
    <div class="toolbar">
      <div class="seg" role="group" aria-label="並び順">
        ${[['profit', '利益額'], ['margin', '利益率'], ['sales', '売れ行き']].map(([k, l]) => `<button data-sort="${k}" aria-pressed="${app.sort === k}">${l}</button>`).join('')}
      </div>
      <label class="toggle"><input type="checkbox" id="only-profit" ${app.onlyProfit ? 'checked' : ''}>黒字だけ</label>
    </div>
    <div class="list">
      ${shown.map(({ p, c, s7 }) => productCard(p, c, s7)).join('') || '<div class="empty">条件に合う商品がありません。</div>'}
    </div>
    ${hidden > 0 ? `<button class="more-btn" data-show-all>ほか ${hidden} 件（赤字・日本の価格が取れなかったもの）を表示</button>` : ''}
  `;
}

function productCard(p, c, s7) {
  let right, line2;
  if (!c) {
    right = '<div class="rate">eBay取得なし</div>';
    line2 = 'eBay の相場を取得できませんでした';
  } else {
    const basis = c.basis === 'match'
      ? `<span class="basis basis-match">型番一致 ${p.match.n}組</span>`
      : '<span class="basis">目安</span>';
    right = c.profit != null
      ? `<div class="amt ${c.profit >= 0 ? 'pos' : 'neg'}">${signedYen(c.profit)}</div><div class="rate">利益率 ${pct(c.margin)}</div>${basis}`
      : '<div class="rate">日本の価格なし</div>';
    line2 = `eBay ${usd(c.sell)}（${yen(c.salesJpy)}）· 仕入 ${yen(c.buy)}`;
  }
  const hist = histOf(p.id).slice(-14).map((r) => (r.s1 || 0) + (r.v1 || 0));
  const sales = `${liqBadge(p)}${trackedDays() >= 2 ? `7日で <b style="color:var(--ink)">${s7}</b>個` : `出品 ${p.ebay?.n ?? 0}件`}`;
  return `
    <div class="card">
      <button class="card-main" data-open="${esc(p.id)}">
        ${thumb(p.img, p.name)}
        <div class="name">${esc(p.name)}<span class="genre">${esc(genreName(p.g))}</span></div>
        <div class="profit">${right}</div>
        <div class="line2">${line2}</div>
        <div class="line3">${sales}${spark(hist)}</div>
        ${liqStrip(p)}
      </button>
      ${linkRow('日本で探す', buyLinks(p.q_ja))}
    </div>`;
}

/* ================================================================ 画面: 売れ筋 */

const ETSY_NOTICE = 'The term "Etsy" is a trademark of Etsy, Inc. This application uses the Etsy API but is not endorsed or certified by Etsy, Inc.';

function renderHot() {
  const fx = fxRate();
  const src = app.hotSource;
  const genres = app.data.genres.filter((g) => inGenre(g.id));
  const etsyReady = app.data.sources?.etsy || Object.keys(app.data.etsy_discovery || {}).length > 0;

  // 相場の行: この出品 / メルカリ売り切れ / ヤフオク落札 / eBay 落札（英語のまま検索）
  const priceRow = (x, site) => {
    const [mercari, yahoo, ebay] = soldLinks(jaQuery(x.t, false), jaQuery(x.t));
    return linkRow('相場', [{ short: `${site}出品`, name: site, sub: 'この出品', url: x.u }, mercari, yahoo, ebay]);
  };
  const ebayCard = (x) => `<div class="disc">
      ${thumb(x.i, x.t)}
      <div>
        <div class="title">${esc(x.t)}</div>
        <div class="nums"><b>${usd(x.p)}</b>（${yen(x.p * fx)}）· 累計 <b>${x.s}</b>個${x.s1 ? ` · 昨日 <b>+${x.s1}</b>` : ''}</div>
      </div>
      ${linkRow('日本で探す', buyLinks(jaQuery(x.t)))}
      ${priceRow(x, 'eBay')}
    </div>`;
  const etsyCard = (x) => `<div class="disc">
      ${thumb(null, x.t)}
      <div>
        <div class="title">${esc(x.t)}</div>
        <div class="nums"><b>${usd(x.p)}</b>（${yen(x.p * fx)}）${x.s1 ? ` · 昨日 <b>${x.s1}個</b>売れた` : ''}${x.qty != null ? ` · 在庫 ${x.qty}` : ''}</div>
        <div class="nums">お気に入り <b>${x.fav}</b>${x.favup > 0 && x.days ? `（${x.days}日で +${x.favup}）` : ''}${
          x.shop?.sold != null ? ` · このショップの累計販売 <b>${x.shop.sold.toLocaleString('ja-JP')}</b>件` : ''}</div>
      </div>
      ${linkRow('日本で探す', buyLinks(jaQuery(x.t)))}
      ${priceRow(x, 'Etsy')}
    </div>`;

  let body;
  if (src === 'etsy' && !etsyReady) {
    body = `<section class="panel prose">
      <h3 style="color:var(--ink)">Etsy はキーの登録待ちです</h3>
      <p>Etsy の API キーを GitHub の Secrets に <code>ETSY_API_KEY</code> として入れると、日本のショップの売れ筋が毎朝ここに出ます。</p>
    </section>`;
  } else {
    const data = src === 'etsy' ? app.data.etsy_discovery : app.data.discovery;
    body = genres.map((g) => {
      const list = data?.[g.id] || [];
      const rows = (app.history?.genres?.[g.id] || []).slice(-30);
      const sold30 = rows.reduce((a, r) => a + (src === 'etsy' ? (r.es1 || 0) : (r.s1 || 0)), 0);
      const ended30 = rows.reduce((a, r) => a + (src === 'etsy' ? (r.ev1 || 0) : (r.v1 || 0)), 0);
      const head = `<div class="section-title">${esc(g.name)}<span class="section-sub">追跡中の出品から、30日で売れた ${sold30}個 · 終了 ${ended30}件</span></div>`;
      if (!list.length) return `${head}<div class="note">まだ見つかっていません。</div>`;
      return `${head}<div class="list">${list.map(src === 'etsy' ? etsyCard : ebayCard).join('')}</div>`;
    }).join('');
  }

  const note = src === 'etsy'
    ? 'Etsy で日本のショップが出している商品。お気に入りの多い順で、在庫が前日から減ったものは「売れた」と表示します。'
    : '日本から発送されている eBay の出品のうち、実際に売れているもの。「累計」はその出品で売れた個数、「昨日」は前日から増えた数です。';

  view.innerHTML = `
    ${demoBanner()}
    <div class="toolbar">
      <div class="seg" role="group" aria-label="販売先">
        ${[['ebay', 'eBay'], ['etsy', 'Etsy']].map(([k, l]) => `<button data-hot="${k}" aria-pressed="${src === k}">${l}</button>`).join('')}
      </div>
    </div>
    <p class="note">${note}「日本で探す」は販売中の出品を安い順で開きます。</p>
    ${body}
    ${src === 'etsy' ? `<p class="note" style="margin-top:16px">${esc(ETSY_NOTICE)}</p>` : ''}
  `;
}

/* ================================================================ 画面: 推移 */

function renderMarket() {
  app.charts = [];
  const H = app.history || {};
  const genres = app.data.genres.filter((g) => inGenre(g.id));
  const start = H.start ? md(H.start) : '—';
  const stacks = [
    { key: 's1', name: '売れた数', color: 'var(--ebay)' },
    { key: 'v1', name: '終了した出品', color: 'var(--aux)' },
  ];

  const ranking = app.data.products.filter((p) => inGenre(p.g))
    .map((p) => ({ p, s7: sold7(p.id), c: calc(p) }))
    .sort((a, b) => b.s7 - a.s7 || (b.p.ebay?.sold_total || 0) - (a.p.ebay?.sold_total || 0))
    .slice(0, 10);

  view.innerHTML = `
    ${demoBanner()}
    <p class="note">${start} から計測して ${trackedDays()} 日目。「売れた数」は複数個出品の販売数の増加、「終了した出品」は検索から消えて出品が終わっていたもの（売れた可能性が高い）です。</p>
    ${genres.map((g) => {
      const rows = (H.genres?.[g.id] || []).slice(-30);
      const last7 = rows.slice(-7);
      return `<section class="panel">
        <h3>${esc(g.name)}</h3>
        <p class="panel-sub">eBay 直近7日: 売れた ${last7.reduce((a, r) => a + (r.s1 || 0), 0)}個 · 終了した出品 ${last7.reduce((a, r) => a + (r.v1 || 0), 0)}件${
          last7.some((r) => r.es1 != null) ? `<br>Etsy 直近7日: 在庫が減った ${last7.reduce((a, r) => a + (r.es1 || 0), 0)}個 · 終了した出品 ${last7.reduce((a, r) => a + (r.ev1 || 0), 0)}件` : ''}</p>
        ${legend(stacks, true)}
        <div class="chart" data-bars="${g.id}"></div>
        ${dataTable(['日付', '売れた数', '終了した出品', '追跡中の出品'], rows.slice().reverse().map((r) => [md(r.d), r.s1 ?? 0, r.v1 ?? 0, r.n ?? 0]))}
      </section>`;
    }).join('')}
    <section class="panel">
      <h3>直近7日でよく売れた商品</h3>
      <p class="panel-sub">監視リストの商品。タップで詳細</p>
      <table class="data-table">
        <thead><tr><th>商品</th><th>7日</th><th>相場</th><th>利益</th></tr></thead>
        <tbody>${ranking.map(({ p, s7, c }) => `<tr data-open="${esc(p.id)}" style="cursor:pointer"><td class="rank-name">${esc(p.name)}</td><td>${s7}個</td><td>${usd(p.ebay?.sell)}</td><td class="${c?.profit > 0 ? 'pos' : c?.profit < 0 ? 'neg' : ''}">${signedYen(c?.profit)}</td></tr>`).join('')}</tbody>
      </table>
    </section>
    <section class="panel">
      <h3>ドル円レート</h3>
      <p class="panel-sub">1ドルあたりの円（毎朝の取得時点）</p>
      <div class="chart" id="fx-chart"></div>
    </section>
  `;

  for (const g of genres) {
    mountChart(view.querySelector(`[data-bars="${g.id}"]`), (el) => barChart(el, { rows: (H.genres?.[g.id] || []).slice(-30), stacks }));
  }
  mountChart(view.querySelector('#fx-chart'), (el) => lineChart(el, {
    series: [{ name: 'ドル円', color: 'var(--ebay)', rows: (H.fx || []).slice(-90).map((r) => ({ d: r.d, v: r.v })) }],
    fmt: (v) => `${v.toFixed(1)}円`, axisFmt: (v) => `${+v.toFixed(1)}`, height: 150,
  }));
}

/* ================================================================ iPhone の通知 */

// Railway で動かす通知サーバーの URL（push-server/）。空のあいだは通知の設定を出さない
const PUSH_API = 'https://jp-resale-watch-production.up.railway.app';
const PUSH_DEFAULTS = { minProfit: 10000, minMargin: 0.15, quiet: true };

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function b64urlToBytes(s) {
  const b = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function pushApi(path, body) {
  const res = await fetch(PUSH_API + path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

async function currentSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

function pushPrefsFromForm() {
  const val = (id) => Number(document.getElementById(id)?.value);
  const S = app.settings;
  return {
    minProfit: Number.isFinite(val('push-min-profit')) ? val('push-min-profit') : PUSH_DEFAULTS.minProfit,
    minMargin: Number.isFinite(val('push-min-margin')) ? val('push-min-margin') / 100 : PUSH_DEFAULTS.minMargin,
    quiet: document.getElementById('push-quiet')?.checked !== false,
    // 利益の計算を画面と同じにするため、この端末の手数料・送料の設定も送る
    settings: {
      fee_rate: S.fee_rate, fixed_fee_usd: S.fixed_fee_usd, fx_loss_rate: S.fx_loss_rate,
      other_cost_rate: S.other_cost_rate, domestic_ship_jpy: S.domestic_ship_jpy, ship_jpy: S.ship_jpy,
      fx_override: S.fx_override,
    },
  };
}

async function renderPushPanel() {
  const el = document.getElementById('push-panel');
  if (!el) return;
  const head = '<h3>iPhone の通知</h3><p class="panel-sub">毎朝のデータ更新のあと、条件に合う商品があれば通知します</p>';
  if (!PUSH_API) {
    el.innerHTML = `${head}<p class="note">通知サーバーの準備中です。</p>`;
    return;
  }
  if (!pushSupported() || location.protocol !== 'https:') {
    el.innerHTML = `${head}<p class="note">${isIOS && !isStandalone()
      ? 'Safari の共有ボタンから「ホーム画面に追加」し、ホーム画面のアイコンから開くと通知を使えます（iOS 16.4 以降）。'
      : 'このブラウザでは通知を使えません。'}</p>`;
    return;
  }
  let sub = null;
  let status = { subscribed: false, prefs: PUSH_DEFAULTS };
  try {
    sub = await currentSubscription();
    if (sub) status = await pushApi(`/api/status?endpoint=${enc(sub.endpoint)}`);
  } catch (e) {
    el.innerHTML = `${head}<p class="note">通知サーバーにつながりません（${esc(e.message)}）。</p>`;
    return;
  }
  const on = !!(sub && status.subscribed);
  const P = { ...PUSH_DEFAULTS, ...status.prefs };
  const blocked = Notification.permission === 'denied';
  el.innerHTML = `${head}
    <ul class="status-list"><li><span>状態</span><span class="${on ? 'ok' : 'ng'}">${on ? 'オン' : blocked ? 'ブロック中（iPhone の設定 → 通知 で許可）' : 'オフ'}</span></li></ul>
    <div class="field"><label for="push-min-profit">最低の見込み利益</label><div class="inp"><input id="push-min-profit" type="number" inputmode="numeric" step="1000" value="${P.minProfit}"><span class="unit">円</span></div></div>
    <div class="field"><label for="push-min-margin">最低の利益率</label><div class="inp"><input id="push-min-margin" type="number" inputmode="decimal" step="1" value="${Math.round(P.minMargin * 100)}"><span class="unit">%</span></div></div>
    <label class="check"><input type="checkbox" id="push-quiet" ${P.quiet ? 'checked' : ''}>条件に合う商品が無い日は通知しない</label>
    <div class="btn-row">
      ${on
        ? '<button class="btn" data-push="save">条件を保存</button><button class="btn" data-push="test">テスト通知</button><button class="btn" data-push="off">通知をオフ</button>'
        : `<button class="btn btn-primary" data-push="on" ${blocked ? 'disabled' : ''}>通知をオンにする</button>`}
    </div>
    <p class="note" id="push-msg" style="margin:8px 0 0"></p>`;
}

async function onPushAction(action) {
  const msg = (t) => { const m = document.getElementById('push-msg'); if (m) m.textContent = t; };
  try {
    if (action === 'on') {
      // iPhone では、ボタンを押した流れの中で最初に許可を求める必要がある
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('通知が許可されませんでした');
      const { publicKey } = await pushApi('/api/vapid');
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription())
        || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(publicKey) }));
      await pushApi('/api/subscribe', { subscription: sub.toJSON(), prefs: pushPrefsFromForm() });
      await renderPushPanel();
      msg('通知をオンにしました。「テスト通知」で届くか確かめられます。');
      return;
    }
    const sub = await currentSubscription();
    if (!sub) throw new Error('この端末は登録されていません');
    if (action === 'save') {
      await pushApi('/api/prefs', { endpoint: sub.endpoint, prefs: pushPrefsFromForm() });
      msg('条件を保存しました。');
    } else if (action === 'test') {
      msg('送信中…');
      await pushApi('/api/test', { endpoint: sub.endpoint });
      msg('テスト通知を送りました。数秒で届きます。');
    } else if (action === 'off') {
      await pushApi('/api/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
      await renderPushPanel();
      msg('通知をオフにしました。');
    }
  } catch (e) {
    msg(`できませんでした: ${e.message}`);
  }
}

/** 通知から開いたとき（#p=商品ID）はその商品の詳細を出す。 */
function openFromHash() {
  const m = location.hash.match(/^#p=(.+)$/);
  if (!m || !app.data) return;
  history.replaceState(null, '', location.pathname + location.search);
  openDetail(decodeURIComponent(m[1]));
}
window.addEventListener('hashchange', openFromHash);

/* ================================================================ 画面: 設定 */

function renderSettings() {
  app.charts = [];
  const S = app.settings, D = app.data;
  const field = (id, label, hint, value, unit, step = 'any') => `
    <div class="field">
      <label for="${id}">${label}${hint ? `<small>${hint}</small>` : ''}</label>
      <div class="inp"><input id="${id}" type="number" inputmode="decimal" step="${step}" value="${value ?? ''}" placeholder="${id === 'fx_override' ? D.fx.usdjpy : ''}">${unit ? `<span class="unit">${unit}</span>` : ''}</div>
    </div>`;
  const r2 = (v) => +(v * 100).toFixed(2);

  let repo = null;
  if (location.hostname.endsWith('github.io')) {
    repo = `https://github.com/${location.hostname.split('.')[0]}/${location.pathname.split('/')[1]}`;
  }
  const src = D.sources || {};
  const status = [['eBay', src.ebay], ['楽天市場', src.rakuten], ['Yahoo!ショッピング', src.yahoo], ['Etsy', src.etsy]];

  view.innerHTML = `
    <section class="panel">
      <h3>利益計算の条件</h3>
      <p class="panel-sub">この端末だけに保存されます。変えるとすぐ全商品の利益に反映されます。</p>
      ${field('fee_rate', 'eBay 手数料', '落札手数料＋海外手数料の合計の目安', r2(S.fee_rate), '%')}
      ${field('fixed_fee_usd', '1件ごとの固定手数料', '', S.fixed_fee_usd, '$')}
      ${field('fx_loss_rate', '為替手数料', '売上を円に替えるときの目減り', r2(S.fx_loss_rate), '%')}
      ${field('other_cost_rate', '関税・その他の負担', '売値に対する割合', r2(S.other_cost_rate), '%')}
      ${field('domestic_ship_jpy', '仕入れの国内送料', '', S.domestic_ship_jpy, '円', 1)}
      ${D.genres.map((g) => field(`ship_${g.id}`, `国際送料: ${esc(g.name)}`, '', S.ship_jpy[g.id], '円', 1)).join('')}
      ${field('fx_override', 'ドル円レートを固定', '空欄なら毎朝の実レート', S.fx_override, '円')}
      <div style="margin-top:10px"><button class="btn" id="reset-settings">初期値に戻す</button></div>
    </section>

    <section class="panel" id="push-panel"><h3>iPhone の通知</h3><p class="note">読み込み中…</p></section>

    <section class="panel">
      <h3>データの状態</h3>
      <ul class="status-list">
        <li><span>最終更新</span><span>${esc(D.generated_at.replace('T', ' ').slice(0, 16))}</span></li>
        <li><span>ドル円</span><span>${D.fx.usdjpy}円（${esc(D.fx.source)}）</span></li>
        ${status.map(([n, ok]) => `<li><span>${n}</span><span class="${ok ? 'ok' : 'ng'}">${ok ? '接続中' : '未設定'}</span></li>`).join('')}
        <li><span>監視中の商品</span><span>${D.products.length}件</span></li>
        <li><span>計測日数</span><span>${trackedDays()}日</span></li>
      </ul>
      ${repo ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
        <a class="btn" href="${repo}/edit/main/config/watchlist.json" target="_blank" rel="noopener">監視リストを編集</a>
        <a class="btn" href="${repo}/actions" target="_blank" rel="noopener">取得の実行状況</a>
      </div>` : ''}
    </section>

    <section class="panel prose">
      <h3 style="color:var(--ink)">数字の見方</h3>
      <p><b>eBay 相場</b>: 日本から発送されている出品の「送料込みの価格」の中央値。売れている出品が3件以上あればその中央値を使います。</p>
      <p><b>仕入れ目安</b>: 楽天市場と Yahoo!ショッピングで見つかった価格の安い方から25%の位置。メルカリ・ヤフオクは自動では取らないので、詳細画面のボタンで確認してください。</p>
      <p><b>売れた数</b>: 同じ品を複数個出品している出品の販売数が前日から増えた分。<b>終了した出品</b>は、前日まであった出品が終わっていたもので、売れた可能性が高いものです。</p>
      <p><b>日本で探す</b>: メルカリ・ヤフオク・ラクマ・Yahoo!フリマの販売中の出品を、安い順で開きます。売れ筋の英語タイトルは、よく使う言葉（kimono→着物 など）を日本語に置き換えて検索します。</p>
      <p><b>Etsy</b>: 日本のショップの出品を毎朝調べ、在庫が前日から減った分を「売れた」としています。</p>
      <p>どれも目安です。状態・付属品・真贋・送料の実額・アメリカの関税は品物ごとに違うので、仕入れる前に必ずリンク先で確かめてください。</p>
      <p style="font-size:11.5px">${esc(ETSY_NOTICE)}</p>
    </section>

    <section class="panel prose">
      <h3 style="color:var(--ink)">iPhone のホーム画面に置く</h3>
      <ol>
        <li>Safari でこのページを開く</li>
        <li>下の共有ボタン（□に↑）をタップ</li>
        <li>「ホーム画面に追加」を選ぶ</li>
      </ol>
      <p>ホーム画面のアイコンから開くと、アプリと同じように全画面で使えます。</p>
    </section>
  `;
  renderPushPanel();
}

function onSettingInput(e) {
  const id = e.target.id, raw = e.target.value.trim(), v = raw === '' ? null : Number(raw);
  if (raw !== '' && !Number.isFinite(v)) return;
  const S = app.settings, D = app.data.settings;
  const pctKeys = ['fee_rate', 'fx_loss_rate', 'other_cost_rate'];
  if (pctKeys.includes(id)) S[id] = v == null ? D[id] : v / 100;
  else if (id === 'fixed_fee_usd' || id === 'domestic_ship_jpy') S[id] = v ?? D[id];
  else if (id.startsWith('ship_')) S.ship_jpy[id.slice(5)] = v ?? D.ship_jpy[id.slice(5)];
  else if (id === 'fx_override') S.fx_override = v > 0 ? v : null;
  saveSettings();
  renderMeta();
}

/* ================================================================ 詳細シート */

/** eBay で売れた出品と、日本で同じ型番・色のいちばん安い出品の組み合わせ。 */
function pairsPanel(p) {
  const pairs = p.pairs || [];
  if (!pairs.length) {
    return `<section class="panel"><h3>同じ型番で比べた組み合わせ</h3>
      <p class="note" style="margin:0">売れた出品から型番が読み取れていないため、上の利益は「目安」です（型番の無い工芸品などはこうなります）。</p></section>`;
  }
  const colorJa = { black: 'ブラック', white: 'ホワイト', silver: 'シルバー', gold: 'ゴールド', red: 'レッド', blue: 'ブルー',
    navy: 'ネイビー', green: 'グリーン', yellow: 'イエロー', pink: 'ピンク', purple: 'パープル', orange: 'オレンジ',
    gray: 'グレー', grey: 'グレー', brown: 'ブラウン', beige: 'ベージュ', clear: 'クリア', khaki: 'カーキ', titanium: 'チタン' };
  const rows = pairs.map((x) => {
    const r = x.jp ? calcCore(x.p, x.jp.p, p.g) : null;
    const tag = `型番 ${esc(x.k)}${x.c ? ` · ${colorJa[x.c] || esc(x.c)}` : ''}`;
    return `<div class="pair">
      <a class="row" href="${esc(x.u)}" target="_blank" rel="noopener">
        <span class="t"><span class="src">eBay</span>${esc(x.t)}</span><span class="v">${usd(x.p)}</span>
        <span class="s">${x.kind === 'sold' ? `この出品で ${x.s}個 売れた` : '出品が終わった（売れた可能性が高い）'} · ${tag}</span>
      </a>
      ${x.jp
        ? `<a class="row" href="${esc(x.jp.u)}" target="_blank" rel="noopener">
            <span class="t"><span class="src">${esc(x.jp.src)}</span>${esc(x.jp.t)}</span><span class="v">${yen(x.jp.p)}</span>
            <span class="s">同じ型番 ${x.jp.n}件のうち最安${x.jp.shop ? ` · ${esc(x.jp.shop)}` : ''}</span>
          </a>
          <div class="pair-profit">この組の見込み利益 <b class="${r.profit >= 0 ? 'pos' : 'neg'}">${signedYen(r.profit)}</b>（${pct(r.margin)}）</div>`
        : `<p class="note" style="margin:6px 0 4px">楽天・Yahoo!に同じ型番が見つかりませんでした。</p>
          ${linkRow('日本で探す', buyLinks(x.k))}`}
    </div>`;
  }).join('');
  return `<section class="panel"><h3>同じ型番で比べた組み合わせ</h3>
    <p class="panel-sub">eBay で売れた出品と、日本で同じ型番・色のいちばん安い出品を1組ずつ比べています</p>${rows}</section>`;
}

function liquidityPanel(p) {
  const l = p.ebay?.liq;
  if (!l) return '';
  const r = liqRating(p);
  const row = (label, value, hint) => `<li><span>${label}${hint ? `<small class="hint-inline">${hint}</small>` : ''}</span><span>${value}</span></li>`;
  return `<section class="panel">
    <h3>流動性 ${liqBadge(p)}</h3>
    <p class="panel-sub">eBay で日本から出ている出品（上位${l.tracked}件）を毎日追った記録。${r.note ? esc(r.note) : ''}</p>
    <ul class="status-list">
      ${row('30日の販売数', `${l.s30}個`, '複数個出品の販売＋終わった出品')}
      ${row('売れる率', l.str != null ? pct(l.str) : '—', '売れた数 ÷（売れた数＋出品数）')}
      ${row('在庫がはける日数', l.dos != null ? `${l.dos}日` : '—', '今の出品数 ÷ 1日の販売数')}
      ${row('14日のうち売れた日', `${l.d14}日`)}
      ${row('売れた値段の中央値', l.med != null ? `${usd(l.med)}（${l.cnt}件）` : '—')}
      ${row('売り手の数', `${l.sellers}人`)}
      ${row('計測日数', `${l.days ?? 0}日`)}
    </ul>
    <p class="note" style="margin:8px 0 0">「終わった出品」は売れた可能性が高いものの、出品者が取り下げた場合も含みます。仕入れ前は Terapeak（下のボタン）で実際の販売履歴も確かめてください。</p>
  </section>`;
}

function openDetail(id) {
  const p = app.data.products.find((x) => x.id === id);
  if (!p) return;
  const c = calc(p), fx = fxRate(), S = app.settings;
  const hist = histOf(p.id);
  const fxByDay = new Map((app.history?.fx || []).map((r) => [r.d, r.v]));
  const eb = p.ebay, jp = p.jp;

  const receipt = c ? `
    <table class="receipt">
      <tr><td>eBay 売値（送料込み）<span class="hint">${c.basis === 'match'
        ? `同じ型番で比べた${p.match.n}組の、eBay で売れた値段の中央値`
        : {
          sold: `実際に売れた値段の中央値（${eb.liq?.cnt}件）`,
          multi: '複数個売れている出品の価格の中央値',
          ask: '出品中の価格の中央値（売れた記録がたまるまでの仮の値）',
        }[eb.basis || (eb.sold_med != null ? 'multi' : 'ask')]} · ${usd(c.sell)} × ${fx.toFixed(1)}円</span></td><td>${yen(c.salesJpy)}</td></tr>
      <tr class="minus"><td>eBay 手数料<span class="hint">${+(S.fee_rate * 100).toFixed(2)}% ＋ $${Number(S.fixed_fee_usd).toFixed(2)}</span></td><td>${yen(-c.feeJpy)}</td></tr>
      ${c.otherJpy ? `<tr class="minus"><td>関税・その他<span class="hint">${+(S.other_cost_rate * 100).toFixed(2)}%</span></td><td>${yen(-c.otherJpy)}</td></tr>` : ''}
      <tr class="minus"><td>為替手数料<span class="hint">${+(S.fx_loss_rate * 100).toFixed(2)}%</span></td><td>${yen(-c.fxLossJpy)}</td></tr>
      <tr class="minus"><td>国際送料<span class="hint">${esc(genreName(p.g))}の目安（設定で変更）</span></td><td>${yen(-c.ship)}</td></tr>
      <tr class="minus"><td>仕入れ値<span class="hint">${c.basis === 'match'
        ? `同じ型番・色の日本最安（${p.match.n}組の中央値）`
        : jp ? `楽天・Yahoo!の${jp.n}件のうち安い方から25%（同じ品物かは未確認の目安）` : '日本の価格が見つかりませんでした'}</span></td><td>${c.buy != null ? yen(-c.buy) : '—'}</td></tr>
      <tr class="minus"><td>国内送料</td><td>${yen(-c.domestic)}</td></tr>
      <tr class="total"><td>見込み利益</td><td class="${c.profit > 0 ? 'pos' : c.profit < 0 ? 'neg' : ''}">${signedYen(c.profit)}</td></tr>
    </table>` : '<p class="note">eBay の相場を取得できなかったため計算できません。</p>';

  const topRows = (eb?.top || []).map((x) => `
    <a class="row" href="${esc(x.u)}" target="_blank" rel="noopener">
      <span class="t">${esc(x.t)}</span><span class="v">${usd(x.p)}</span>
      <span class="s">${x.s ? `この出品で ${x.s}個 売れた` : '販売実績なし'}</span>
    </a>`).join('');
  const jpRows = (jp?.items || []).map((x) => `
    <a class="row" href="${esc(x.u)}" target="_blank" rel="noopener">
      <span class="t">${esc(x.t)}</span><span class="v">${yen(x.p)}</span>
      <span class="s">${esc(x.src)}${x.shop ? ` · ${esc(x.shop)}` : ''}</span>
    </a>`).join('');

  sheet.innerHTML = `
    <div class="sheet-head">
      <h2 id="sheet-title">${esc(p.name)}<span class="genre">${esc(genreName(p.g))} · eBay「${esc(p.q_en)}」</span></h2>
      <button class="icon-btn" data-close aria-label="閉じる"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </div>
    <div class="sheet-body">
      ${app.data.demo ? '<div class="banner"><strong>デモデータです。</strong></div>' : ''}
      <div class="tiles">
        <div class="tile"><div class="label">見込み利益</div><div class="value ${c?.profit > 0 ? 'pos' : c?.profit < 0 ? 'neg' : ''}">${c?.profit != null ? man(Math.round(c.profit)) : '—'}</div><div class="sub">円 / 1個</div></div>
        <div class="tile"><div class="label">利益率</div><div class="value">${pct(c?.margin)}</div><div class="sub">売上に対して</div></div>
        <div class="tile"><div class="label">7日で売れた</div><div class="value">${sold7(p.id)}</div><div class="sub">個（出品 ${eb?.n ?? 0}件）</div></div>
      </div>

      <section class="panel"><h3>利益の内訳</h3><p class="panel-sub">1個売れた場合の見込み</p>${receipt}</section>

      ${pairsPanel(p)}

      ${liquidityPanel(p)}

      <section class="panel">
        <h3>価格の推移</h3>
        <p class="panel-sub">円換算。eBay は送料込みの売値、日本は仕入れ目安</p>
        ${legend([{ name: 'eBay 売値', color: 'var(--ebay)' }, { name: '日本の仕入れ目安', color: 'var(--jp)' }])}
        <div class="chart" id="price-chart"></div>
        ${dataTable(['日付', 'eBay 売値', '日本の仕入れ目安'], hist.slice(-60).reverse().map((r) => [md(r.d), r.sell != null ? yen(r.sell * (fxByDay.get(r.d) || fx)) : '—', yen(r.jp)]))}
      </section>

      <section class="panel">
        <h3>日別の販売</h3>
        <p class="panel-sub">この商品の eBay 出品（日本発送）</p>
        ${legend([{ name: '売れた数', color: 'var(--ebay)' }, { name: '終了した出品', color: 'var(--aux)' }], true)}
        <div class="chart" id="sold-chart"></div>
      </section>

      ${topRows ? `<section class="panel"><h3>eBay でよく売れている出品</h3><div class="rows">${topRows}</div></section>` : ''}
      ${jpRows ? `<section class="panel"><h3>日本の安い出品</h3><div class="rows">${jpRows}</div></section>` : ''}
      ${p.etsy ? `<section class="panel"><h3>Etsy（日本のショップ）</h3><ul class="status-list"><li><span>出品数</span><span>${p.etsy.n}件</span></li><li><span>価格の中央値</span><span>${usd(p.etsy.med)}</span></li><li><span>昨日消えた出品</span><span>${p.etsy.v1}件</span></li></ul></section>` : ''}

      <section class="panel">
        <h3>日本で買える出品</h3>
        <p class="panel-sub">「${esc(p.q_ja)}」で、販売中の出品を安い順に開きます</p>
        <div class="link-grid">${[...buyLinks(p.q_ja),
          { name: '楽天市場', sub: '安い順', url: `https://search.rakuten.co.jp/search/mall/${enc(p.q_ja)}/?s=2` },
          { name: 'Yahoo!ショッピング', sub: '安い順', url: `https://shopping.yahoo.co.jp/search?p=${enc(p.q_ja)}&X=2` },
        ].map(gridLink).join('')}</div>
      </section>

      <section class="panel">
        <h3>売れた価格を確かめる</h3>
        <p class="panel-sub">日本は売り切れ・落札済み、海外は売れた出品の一覧</p>
        <div class="link-grid">${soldLinks(p.q_en, p.q_ja).map(gridLink).join('')}</div>
      </section>
      ${p.errors?.length ? `<p class="note">取得エラー: ${p.errors.map(esc).join(' / ')}</p>` : ''}
    </div>
  `;
  app.sheetCharts = [];
  if (!sheet.open) sheet.showModal();
  sheet.querySelector('.sheet-body').scrollTop = 0;

  mountChart(sheet.querySelector('#price-chart'), (el) => lineChart(el, {
    series: [
      { name: 'eBay 売値', color: 'var(--ebay)', rows: hist.slice(-60).filter((r) => r.sell != null).map((r) => ({ d: r.d, v: r.sell * (fxByDay.get(r.d) || fx) })) },
      { name: '日本の仕入れ目安', color: 'var(--jp)', rows: hist.slice(-60).filter((r) => r.jp != null).map((r) => ({ d: r.d, v: r.jp })) },
    ],
    fmt: (v) => yen(v), axisFmt: man,
  }), app.sheetCharts);
  mountChart(sheet.querySelector('#sold-chart'), (el) => barChart(el, {
    rows: hist.slice(-30),
    stacks: [{ key: 's1', name: '売れた数', color: 'var(--ebay)' }, { key: 'v1', name: '終了した出品', color: 'var(--aux)' }],
  }), app.sheetCharts);
}

/* ================================================================ 画面切り替え */

function render() {
  if (!app.data) return;
  app.charts = [];
  document.querySelectorAll('.tabbar button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === app.tab)));
  document.getElementById('genres').hidden = app.tab === 'settings';
  ({ profit: renderProfit, hot: renderHot, market: renderMarket, settings: renderSettings }[app.tab] || renderProfit)();
}

document.querySelector('.tabbar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b || b.dataset.tab === app.tab) { if (b) window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  app.tab = b.dataset.tab;
  app.showAll = false;
  store.set('tab', app.tab);
  render();
  window.scrollTo(0, 0);
});

document.getElementById('genres').addEventListener('click', (e) => {
  const b = e.target.closest('[data-genre]');
  if (!b) return;
  app.genre = b.dataset.genre;
  app.showAll = false;
  store.set('genre', app.genre);
  document.querySelectorAll('#genres .chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.genre === app.genre)));
  render();
});

view.addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open) return openDetail(open.dataset.open);
  const sort = e.target.closest('[data-sort]');
  if (sort) { app.sort = sort.dataset.sort; store.set('sort', app.sort); return render(); }
  const hot = e.target.closest('[data-hot]');
  if (hot) { app.hotSource = hot.dataset.hot; store.set('hotSource', app.hotSource); return render(); }
  if (e.target.closest('[data-show-all]')) { app.showAll = true; return render(); }
  const pushBtn = e.target.closest('[data-push]');
  if (pushBtn) return onPushAction(pushBtn.dataset.push);
  if (e.target.id === 'reset-settings') {
    store.del('settings');
    app.settings = mergeSettings(app.data.settings);
    renderMeta();
    return render();
  }
});

view.addEventListener('change', (e) => {
  if (e.target.id === 'only-profit') {
    app.onlyProfit = e.target.checked;
    app.showAll = false;
    store.set('onlyProfit', String(app.onlyProfit));
    render();
  }
});

view.addEventListener('input', (e) => {
  if (app.tab === 'settings' && e.target.matches('input[type="number"]') && !e.target.id.startsWith('push-')) onSettingInput(e);
});

sheet.addEventListener('click', (e) => {
  if (e.target === sheet || e.target.closest('[data-close]')) sheet.close();
});
sheet.addEventListener('close', () => { app.sheetCharts = []; });

document.getElementById('reload').addEventListener('click', load);

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => [...app.charts, ...app.sheetCharts].forEach((draw) => draw()), 150);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && app.data && app.data.date !== todayJst()) load();
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* オフライン対応なしでも動く */ });
}

load();
