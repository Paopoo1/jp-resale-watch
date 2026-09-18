// EXPORT RADAR SYSTEM の通知サーバー。
//
// iPhone のホーム画面アプリから通知の登録を受け付け、毎朝のデータ（GitHub Pages の latest.json）が
// 新しくなったら、登録ごとの条件（最低利益・利益率）に合う商品をプッシュ通知で知らせる。
//
// 環境変数（どれも省略可）:
//   PORT                      Railway が設定する
//   RAILWAY_VOLUME_MOUNT_PATH ボリュームを付けると Railway が設定する。登録と鍵をここに保存する
//   APP_URL                   アプリの URL（既定: https://paopoo1.github.io/jp-resale-watch/）
//   ALLOWED_ORIGINS           登録を受け付けるページのオリジン（カンマ区切り）
//   POLL_MINUTES              データ更新を確かめる間隔（既定 10 分）
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY  無ければ初回起動時に作ってボリュームに保存する

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || './data';
const APP_URL = process.env.APP_URL || 'https://paopoo1.github.io/jp-resale-watch/';
const DATA_URL = new URL('data/latest.json', APP_URL).href;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || `${new URL(APP_URL).origin},http://localhost:8765`).split(',');
const POLL_MINUTES = Number(process.env.POLL_MINUTES || 10);
const STATE_FILE = path.join(DATA_DIR, 'push-state.json');

const DEFAULT_PREFS = { minProfit: 10000, minMargin: 0.15, quiet: true };

/* ---------------------------------------------------------------- 保存 */

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { subs: {}, lastGenerated: null };
  }
}

function saveState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}

const state = loadState();
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  state.vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
} else if (!state.vapid) {
  state.vapid = webpush.generateVAPIDKeys();
  saveState();
  console.log('VAPID の鍵を作りました（ボリュームに保存）');
}
// 通知サービスに伝える連絡先。https か mailto でないといけない
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || (APP_URL.startsWith('https:') ? APP_URL : 'https://paopoo1.github.io/jp-resale-watch/');
webpush.setVapidDetails(VAPID_SUBJECT, state.vapid.publicKey, state.vapid.privateKey);
if (!process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  console.warn('注意: ボリュームが付いていないので、再デプロイすると通知の登録が消えます');
}

/* ---------------------------------------------------------------- 通知の中身 */

const yen = (v) => `${v < 0 ? '−' : '+'}¥${Math.abs(Math.round(v)).toLocaleString('ja-JP')}`;

/** アプリと同じ計算で、1個売ったときの見込み利益を出す。 */
function profitOf(p, S, fx) {
  const sell = p.ebay?.sell;
  const buy = p.jp?.p25;
  if (sell == null || buy == null) return null;
  const fee = sell * S.fee_rate + S.fixed_fee_usd;
  const net = (sell - fee - sell * S.other_cost_rate) * fx * (1 - S.fx_loss_rate);
  const profit = net - (S.ship_jpy?.[p.g] ?? 3000) - buy - S.domestic_ship_jpy;
  return { profit, margin: profit / (sell * fx) };
}

function buildMessage(data, sub, { test = false } = {}) {
  const prefs = { ...DEFAULT_PREFS, ...sub.prefs };
  const S = { ...data.settings, ...(prefs.settings || {}) };
  S.ship_jpy = { ...data.settings.ship_jpy, ...(prefs.settings?.ship_jpy || {}) };
  const fx = prefs.settings?.fx_override > 0 ? prefs.settings.fx_override : data.fx.usdjpy;

  const hits = data.products
    .map((p) => ({ p, r: profitOf(p, S, fx) }))
    .filter(({ r }) => r && r.profit >= prefs.minProfit && r.margin >= prefs.minMargin)
    .sort((a, b) => b.r.profit - a.r.profit);
  const sold = data.products.reduce((a, p) => a + (p.ebay?.s1 || 0), 0);

  if (!hits.length && prefs.quiet && !test) return null;
  const lines = hits.slice(0, 3).map(({ p, r }) => `${p.name} ${yen(r.profit)}（${Math.round(r.margin * 100)}%）`);
  if (hits.length > 3) lines.push(`ほか ${hits.length - 3} 件`);
  if (!hits.length) lines.push(`条件（${yen(prefs.minProfit)}以上・${Math.round(prefs.minMargin * 100)}%以上）に合う商品はありませんでした`);
  if (sold) lines.push(`昨日 eBay で売れた数: ${sold}個`);
  return {
    title: `${test ? '【テスト】' : ''}利益候補 ${hits.length}件`,
    body: lines.join('\n'),
    url: hits.length ? `${APP_URL}#p=${encodeURIComponent(hits[0].p.id)}` : APP_URL,
    tag: test ? 'test' : `daily-${data.date}`,
  };
}

async function fetchData() {
  const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`latest.json: HTTP ${res.status}`);
  return res.json();
}

async function send(endpoint, message) {
  const sub = state.subs[endpoint];
  try {
    await webpush.sendNotification(sub.subscription, JSON.stringify(message), { TTL: 12 * 3600, urgency: 'normal' });
    sub.lastSent = new Date().toISOString();
    return true;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) {
      delete state.subs[endpoint]; // iPhone 側で通知がオフにされた
      console.log('期限切れの登録を削除しました');
    } else {
      console.error('通知の送信に失敗:', e.statusCode || '', e.body || e.message);
    }
    return false;
  }
}

/** データが新しくなっていたら、全員に通知する。 */
async function poll() {
  try {
    const data = await fetchData();
    if (data.demo || data.generated_at === state.lastGenerated) return;
    const first = state.lastGenerated === null;
    state.lastGenerated = data.generated_at;
    if (first) {
      console.log(`データ ${data.generated_at} を基準にしました（起動直後は送りません）`);
    } else {
      let n = 0;
      for (const endpoint of Object.keys(state.subs)) {
        const msg = buildMessage(data, state.subs[endpoint]);
        if (msg && (await send(endpoint, msg))) n++;
      }
      console.log(`データ ${data.generated_at}: ${n}件に通知しました`);
    }
    saveState();
  } catch (e) {
    console.error('データの確認に失敗:', e.message);
  }
}

/* ---------------------------------------------------------------- HTTP */

function reply(res, status, body, origin) {
  const headers = { 'content-type': 'application/json; charset=utf-8' };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    Object.assign(headers, {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      vary: 'origin',
    });
  }
  res.writeHead(status, headers);
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 20000) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('bad json')); }
    });
  });
}

function cleanPrefs(p = {}) {
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const out = {
    minProfit: num(p.minProfit, DEFAULT_PREFS.minProfit),
    minMargin: num(p.minMargin, DEFAULT_PREFS.minMargin),
    quiet: p.quiet !== false,
  };
  if (p.settings && typeof p.settings === 'object') {
    const s = p.settings;
    out.settings = {};
    for (const k of ['fee_rate', 'fixed_fee_usd', 'fx_loss_rate', 'other_cost_rate', 'domestic_ship_jpy', 'fx_override']) {
      if (Number.isFinite(Number(s[k])) && s[k] !== null) out.settings[k] = Number(s[k]);
    }
    if (s.ship_jpy && typeof s.ship_jpy === 'object') {
      out.settings.ship_jpy = Object.fromEntries(
        Object.entries(s.ship_jpy).filter(([, v]) => Number.isFinite(Number(v))).map(([k, v]) => [String(k).slice(0, 20), Number(v)]),
      );
    }
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return reply(res, 204, undefined, origin);

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      return reply(res, 200, { app: 'EXPORT RADAR push', subscribers: Object.keys(state.subs).length, lastGenerated: state.lastGenerated }, origin);
    }
    if (req.method === 'GET' && url.pathname === '/api/vapid') {
      return reply(res, 200, { publicKey: state.vapid.publicKey }, origin);
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const sub = state.subs[url.searchParams.get('endpoint') || ''];
      return reply(res, 200, { subscribed: !!sub, prefs: sub ? { ...DEFAULT_PREFS, ...sub.prefs } : DEFAULT_PREFS }, origin);
    }
    if (req.method !== 'POST') return reply(res, 404, { error: 'not found' }, origin);

    const body = await readBody(req);
    const endpoint = body.subscription?.endpoint || body.endpoint;
    if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint)) return reply(res, 400, { error: 'endpoint がありません' }, origin);

    if (url.pathname === '/api/subscribe') {
      const s = body.subscription;
      if (!s?.keys?.p256dh || !s?.keys?.auth) return reply(res, 400, { error: 'subscription が不正です' }, origin);
      state.subs[endpoint] = {
        subscription: { endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } },
        prefs: cleanPrefs(body.prefs),
        createdAt: state.subs[endpoint]?.createdAt || new Date().toISOString(),
      };
      saveState();
      return reply(res, 200, { ok: true }, origin);
    }
    if (!state.subs[endpoint]) return reply(res, 404, { error: '登録がありません' }, origin);

    if (url.pathname === '/api/prefs') {
      state.subs[endpoint].prefs = cleanPrefs(body.prefs);
      saveState();
      return reply(res, 200, { ok: true }, origin);
    }
    if (url.pathname === '/api/unsubscribe') {
      delete state.subs[endpoint];
      saveState();
      return reply(res, 200, { ok: true }, origin);
    }
    if (url.pathname === '/api/test') {
      const msg = buildMessage(await fetchData(), state.subs[endpoint], { test: true });
      const ok = await send(endpoint, msg);
      saveState();
      return reply(res, ok ? 200 : 502, { ok }, origin);
    }
    return reply(res, 404, { error: 'not found' }, origin);
  } catch (e) {
    return reply(res, 400, { error: e.message }, origin);
  }
});

server.listen(PORT, () => {
  console.log(`通知サーバー起動: port ${PORT} / データ ${DATA_URL} / ${POLL_MINUTES}分ごとに確認`);
  poll();
  setInterval(poll, POLL_MINUTES * 60 * 1000);
});
