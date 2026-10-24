// Sonde API：各工具上报 → D1；网页读取
//   POST   /ingest            上报（Authorization: Bearer INGEST_TOKEN）
//   DELETE /ingest/<source>   删除一个不再使用的来源（同样需要密钥）
//   GET    /api/status        每个来源最新的一份
//   GET    /api/history       近 HISTORY_DAYS 天每小时的指标值，用来画曲线（缓存 5 分钟）

const SOURCE_RE = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const MAX_BODY = 64 * 1024;
const MAX_SERIES = 40;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });

// 常数时间比较，避免按响应时间猜密钥
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b) return false;
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function authorized(req, env) {
  const h = req.headers.get('Authorization') || '';
  return sameToken(h.startsWith('Bearer ') ? h.slice(7) : '', env.INGEST_TOKEN);
}

async function ingest(req, env, ctx) {
  if (!authorized(req, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) return json({ ok: false, error: 'too large' }, 413);
  const text = await req.text();
  if (text.length > MAX_BODY) return json({ ok: false, error: 'too large' }, 413);

  let body;
  try { body = JSON.parse(text); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const { source, data } = body || {};
  if (typeof source !== 'string' || !SOURCE_RE.test(source)) return json({ ok: false, error: 'bad source' }, 400);
  if (!data || typeof data !== 'object') return json({ ok: false, error: 'missing data' }, 400);

  const now = Math.floor(Date.now() / 1000);
  let ts = Math.floor(Number(body.ts) || now);
  if (ts > now + 300 || ts < now - 86400 * 2) ts = now;          // 上报方时钟明显不对时用收到的时间
  const interval = Math.min(Math.max(Math.floor(Number(body.interval) || 600), 30), 86400 * 2);

  const stmts = [
    env.DB.prepare(
      `INSERT INTO latest (source, ts, interval, data, received) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(source) DO UPDATE SET ts = ?2, interval = ?3, data = ?4, received = ?5`,
    ).bind(source, ts, interval, JSON.stringify(data), now),
  ];

  // series：{ 指标名: 数值 }，每小时只留最后一个值
  const hour = ts - (ts % 3600);
  const series = body.series && typeof body.series === 'object' ? Object.entries(body.series) : [];
  for (const [k, v] of series.slice(0, MAX_SERIES)) {
    if (typeof k !== 'string' || k.length > 64 || typeof v !== 'number' || !Number.isFinite(v)) continue;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO history (source, key, hour, v) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(source, key, hour) DO UPDATE SET v = ?4`,
      ).bind(source, k, hour, v),
    );
  }
  await env.DB.batch(stmts);

  // 清理过期历史：大约每 50 次上报做一次，不占 cron
  if (Math.random() < 0.02) {
    const days = Number(env.HISTORY_DAYS) || 7;
    ctx.waitUntil(env.DB.prepare('DELETE FROM history WHERE hour < ?1').bind(now - (days + 1) * 86400).run());
  }
  return json({ ok: true });
}

async function removeSource(req, env, source) {
  if (!authorized(req, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!SOURCE_RE.test(source)) return json({ ok: false, error: 'bad source' }, 400);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM latest WHERE source = ?1').bind(source),
    env.DB.prepare('DELETE FROM history WHERE source = ?1').bind(source),
  ]);
  return json({ ok: true });
}

// data 列存的就是上报时 JSON.stringify 过的文本，直接拼进响应，不再解析一遍再序列化一遍
// （这个接口每 30 秒被每个打开的页面读一次，是 Worker 最常跑的路径）
async function status(env) {
  const { results } = await env.DB.prepare('SELECT source, ts, interval, data, received FROM latest ORDER BY source').all();
  const items = results.map((r) => {
    const data = typeof r.data === 'string' && r.data.startsWith('{') && r.data.endsWith('}') ? r.data : 'null';
    return `{"source":${JSON.stringify(r.source)},"ts":${Number(r.ts) || 0},"interval":${Number(r.interval) || 0},`
      + `"received":${Number(r.received) || 0},"data":${data}}`;
  });
  return new Response(`{"now":${Math.floor(Date.now() / 1000)},"sources":[${items.join(',')}]}`, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, 'Cache-Control': 'no-store' },
  });
}

// 曲线不需要实时，缓存 5 分钟，D1 读取量和打开页面的次数基本无关。两层：
//   Worker 实例内存（哪里都能用，命中时连缓存 I/O 都没有）；边缘 Cache API（只在自定义域名上起作用，workers.dev 上是空操作）
const HISTORY_TTL = 300_000;
let historyMemo = null; // { at, body }
async function history(req, env, ctx) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', ...CORS, 'Cache-Control': 'public, max-age=300' };
  if (historyMemo && Date.now() - historyMemo.at < HISTORY_TTL) return new Response(historyMemo.body, { headers });
  const cache = caches.default;
  const key = new Request(new URL('/api/history', req.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;

  const days = Number(env.HISTORY_DAYS) || 7;
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const { results } = await env.DB.prepare(
    'SELECT source, key, hour, v FROM history WHERE hour >= ?1 ORDER BY source, key, hour',
  ).bind(since).all();
  const out = {};
  for (const r of results) ((out[r.source] ??= {})[r.key] ??= []).push([r.hour, r.v]);
  const body = JSON.stringify({ since, series: out });
  historyMemo = { at: Date.now(), body };
  const res = new Response(body, { headers });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (path === '/ingest' && req.method === 'POST') return await ingest(req, env, ctx);
      if (path.startsWith('/ingest/') && req.method === 'DELETE')
        return await removeSource(req, env, decodeURIComponent(path.slice(8)));
      if (path === '/api/status' && req.method === 'GET') return await status(env);
      if (path === '/api/history' && req.method === 'GET') return await history(req, env, ctx);
      if (path === '/') return new Response('Sonde API\n', { headers: { 'Content-Type': 'text/plain', ...CORS } });
      return json({ ok: false, error: 'not found' }, 404);
    } catch (e) {
      console.error(e);
      return json({ ok: false, error: 'internal error' }, 500);
    }
  },
};
