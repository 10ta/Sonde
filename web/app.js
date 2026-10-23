// Sonde 网页：读 Worker 的 /api/status 和 /api/history，按来源画卡片。纯静态，不需要构建。
(() => {
  'use strict';

  const API = (new URLSearchParams(location.search).get('api') || window.SONDE_API || '').replace(/\/+$/, '');
  const STATUS_MS = 30_000;          // 最新状态多久拉一次
  const HISTORY_MS = 5 * 60_000;     // 曲线多久拉一次（Worker 那边也缓存 5 分钟）

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* 忽略 */ } },
  };

  // ---------- 配色（与 1999 主题相同的 19 套） ----------
  const SCHEMES = {
    'yellow-light': ['Yellow', '#ffffff', '#FFE600'], 'red-light': ['Red', '#ffffff', '#FF3333'],
    'blue-light': ['Blue', '#ffffff', '#0d6eff'], 'green-light': ['Green', '#ffffff', '#00CC66'],
    'purple-light': ['Purple', '#ffffff', '#9B5DE5'], 'solarized-light': ['Solarized', '#fdf6e3', '#e3bd4f'],
    'github-light': ['GitHub', '#ffffff', '#54aeff'], 'gruvbox-light': ['Gruvbox', '#fbf1c7', '#d79921'],
    'catppuccin-light': ['Catppuccin Latte', '#eff1f5', '#bfa0f5'], 'tokyonight-light': ['Tokyo Night Day', '#e9e9ed', '#8fb0f3'],
    'chelsea-light': ['Chelsea', '#ffffff', '#034694'],
    'tokyonight-dark': ['Tokyo Night', '#24283b', '#7aa2f7'], 'dracula-dark': ['Dracula', '#282a36', '#ff79c6'],
    'monokai-dark': ['Monokai', '#272822', '#e6db74'], 'nord-dark': ['Nord', '#3b4252', '#88c0d0'],
    'gruvbox-dark': ['Gruvbox', '#282828', '#fe8019'], 'catppuccin-dark': ['Catppuccin Mocha', '#1e1e2e', '#cba6f7'],
    'psg-dark': ['PSG', '#0e2a4a', '#DA291C'], 'samalive-dark': ['samalive', '#1f333d', '#e0913a'],
  };
  const DEFAULT_SCHEME = 'blue-light';   // 和 Sabonner 的黄色区分开

  // ---------- 工具 ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nowSec = () => Math.floor(Date.now() / 1000);
  const num = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1') : '–');
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const timeFmt = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const fullTime = (ts) => timeFmt.format(new Date(ts * 1000));

  function ago(ts) {
    const s = Math.max(0, nowSec() - ts);
    if (s < 60) return '刚刚';
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
    return `${Math.floor(s / 86400)} 天前`;
  }
  const isOffline = (src) => nowSec() - src.ts > src.interval * 2 + 120;
  const level = (pct) => (pct >= 95 ? 5 : pct >= 80 ? 4 : pct >= 60 ? 3 : pct >= 40 ? 2 : 1);

  // traffic-bot 原文是 TG 用的 HTML：只保留这几个排版标签、去掉所有属性，其余一律当文字
  const TG_TAGS = new Set(['B', 'I', 'U', 'S', 'CODE', 'PRE', 'BLOCKQUOTE']);
  // 🛡 🖥 🗺 ⏸ ☁ 这类 emoji 在 Unicode 里默认按「文字样式」显示：后面不跟 U+FE0F 时，浏览器会按正文字体去找，
  // 常常落到 Segoe UI Symbol 之类的黑白符号字体。这里给它们补上 U+FE0F，让浏览器改用 emoji 字体（彩色）。
  // 默认就是彩色的（🔄 💰）和已经带 FE0F 的（⚠️ ⚙️）不动
  const EMO_RE = /(\p{Extended_Pictographic})(?![\uFE0F\uFE0E\u200D])/gu;
  const emo = (str) => String(str ?? '').replace(EMO_RE, (m, c) => (/\p{Emoji_Presentation}/u.test(c) ? c : `${c}\uFE0F`));

  function tgHtml(html) {
    const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
    const walk = (node) => [...node.childNodes].map((n) => {
      if (n.nodeType === Node.TEXT_NODE) return esc(emo(n.textContent));
      if (n.nodeType !== Node.ELEMENT_NODE || /^(SCRIPT|STYLE|TEMPLATE|IFRAME|OBJECT)$/.test(n.tagName)) return '';
      const inner = walk(n);
      return TG_TAGS.has(n.tagName) ? `<${n.tagName.toLowerCase()}>${inner}</${n.tagName.toLowerCase()}>` : inner;
    }).join('');
    return walk(doc.body.firstChild);
  }

  // ---------- 曲线 ----------
  const charts = new Map();   // id -> { pts, unit, label }
  let chartSeq = 0;

  function pathOf(pts, w, h, lo, hi, x0, x1) {
    const span = hi - lo || 1;
    return pts.map(([t, v], i) => {
      const x = ((t - x0) / (x1 - x0 || 1)) * w;
      const y = h - ((v - lo) / span) * h;
      return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join('');
  }

  // 历史曲线（cfst 卡片用）：左边是纵坐标（上 / 中 / 下三个刻度），横轴只覆盖有数据的那段时间（最多 7 天），
  // 悬停看每个小时的值。高度固定，卡片不会因为有没有数据而变高变矮
  function chart(pts, { label, unit = '', color = 'var(--accent-blue)', min = null, digits = 1 }) {
    const id = `c${++chartSeq}`;
    const H = 44;
    if (!pts || pts.length < 2) {
      return `<div class="chart"><div class="chart-head"><span>${esc(label)}</span><span>数据还不够</span></div>
        <div class="chart-plot"><div class="y-axis"></div><svg viewBox="0 0 300 ${H}"></svg></div></div>`;
    }
    const vals = pts.map((p) => p[1]);
    let lo = min ?? Math.min(...vals), hi = Math.max(...vals);
    if (hi === lo) { hi += 1; lo = Math.max(min ?? -Infinity, lo - 1); }
    const pad = (hi - lo) * 0.08; hi += pad; if (min == null) lo -= pad;
    const x1 = nowSec(), x0 = Math.max(x1 - 7 * 86400, pts[0][0]);
    const spanH = (x1 - x0) / 3600;
    const span = spanH < 48 ? `近 ${Math.max(1, Math.round(spanH))} 小时` : `近 ${Math.round(spanH / 24)} 天`;
    const line = pathOf(pts, 300, H, lo, hi, x0, x1);
    const firstX = (((pts[0][0] - x0) / (x1 - x0)) * 300).toFixed(1);
    const lastX = (((pts[pts.length - 1][0] - x0) / (x1 - x0)) * 300).toFixed(1);
    charts.set(id, { pts, unit, label, digits, lo, hi, x0, x1 });
    const grid = [0.25, 0.5, 0.75].map((f) => `<line class="grid" x1="${f * 300}" x2="${f * 300}" y1="0" y2="${H}"/>`).join('')
      + `<line class="grid" x1="0" x2="300" y1="${H / 2}" y2="${H / 2}"/>`;
    const last = vals[vals.length - 1];
    return `<div class="chart">
      <div class="chart-head"><span>${esc(label)} · ${span}</span><span>当前 <b>${num(last, digits)}</b>${esc(unit)}</span></div>
      <div class="chart-plot">
        <div class="y-axis"><span>${num(hi, digits)}</span><span>${num((hi + lo) / 2, digits)}</span><span>${num(lo, digits)}</span></div>
        <svg viewBox="0 0 300 ${H}" preserveAspectRatio="none" data-chart="${id}" role="img" aria-label="${esc(label)}${span}曲线">
          ${grid}
          <path class="area" d="${line}L${lastX},${H}L${firstX},${H}Z" style="fill:${color}"/>
          <path class="line" d="${line}" style="stroke:${color}"/>
          <line class="cursor" x1="0" x2="0" y1="0" y2="${H}" hidden/>
        </svg>
      </div></div>`;
  }
  const charts2 = (a, b) => `<div class="charts">${a}${b}</div>`;

  const tip = $('#chart-tip');
  const showTip = (e, text) => {
    tip.textContent = text;
    tip.hidden = false;
    tip.style.left = `${clamp(e.clientX + 12, 8, window.innerWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${e.clientY - 36}px`;
  };
  document.addEventListener('pointermove', (e) => {
    const ls = e.target.closest?.('svg[data-ls]');
    document.querySelectorAll('svg[data-ls] line.cursor').forEach((l) => { if (l.ownerSVGElement !== ls) l.setAttribute('hidden', ''); });
    if (ls && lineTip(ls, e)) return;
    const svg = e.target.closest?.('svg[data-chart]');
    document.querySelectorAll('svg[data-chart] line.cursor').forEach((l) => { if (!svg || l.ownerSVGElement !== svg) l.setAttribute('hidden', ''); });
    if (!svg) { tip.hidden = true; return; }
    const c = charts.get(svg.dataset.chart);
    if (!c) return;
    const r = svg.getBoundingClientRect();
    const t = c.x0 + ((e.clientX - r.left) / r.width) * (c.x1 - c.x0);
    let best = c.pts[0];
    for (const p of c.pts) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    const cur = svg.querySelector('line.cursor');
    const x = ((best[0] - c.x0) / (c.x1 - c.x0)) * 300;
    cur.setAttribute('x1', x); cur.setAttribute('x2', x); cur.removeAttribute('hidden');
    showTip(e, `${fullTime(best[0])}  ${num(best[1], c.digits)}${c.unit}`);
  });

  // ---------- 通用片段 ----------
  const bar = (pct, marks = [], cls = '') => {
    const p = clamp(pct, 0, 100);
    return `<div class="bar ${cls}"><span class="ticks"><u></u><u></u><u></u><u></u><u></u><u></u><u></u><u></u><u></u><u></u></span><i class="l${level(pct)}${p <= 0 ? ' zero' : ''}" style="width:${p}%"></i>${
      marks.map(([at, label]) => `<b class="${at > 80 ? 'end' : ''}" style="left:${clamp(at, 0, 100)}%" data-label="${esc(label)}"></b>`).join('')}</div>`;
  };
  const ageBadge = (src) => (isOffline(src)
    ? `<span class="badge bad" title="最后上报 ${esc(fullTime(src.ts))}，应每 ${Math.round(src.interval / 60)} 分钟一次">离线 · ${esc(ago(src.ts))}</span>`
    : `<span class="badge age" title="上报于 ${esc(fullTime(src.ts))}">${esc(ago(src.ts))}</span>`);
  const card = (src, title, badges, body, foot = '', { age = true, cls = '' } = {}) => `
    <article class="card ${cls}${isOffline(src) ? ' offline' : ''}">
      <div class="card-head"><h3>${title}</h3>${badges}${age ? ageBadge(src) : ''}</div>
      <div class="card-body">${body}</div>
      ${foot ? `<div class="card-foot">${foot}</div>` : ''}
    </article>`;
  // 一行文字：放不下就省略号，悬停看全文，点一下展开 / 收起（手机上没有悬停）
  const line = (icon, text, cls = '') => `<p class="line ${cls}" title="${esc(text)}">${icon ? `<span class="ic">${emo(icon)}</span>` : ''}${esc(emo(text || '–'))}</p>`;
  // 2 × 2 的数字格
  const stats = (pairs) => `<dl class="stats">${pairs.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;

  // ---------- 卡片的三层：指标（进度条 + 近 7 天小折线）→ 明细（引用块）→ 状态（普通行） ----------
  // 明细 = 组成上面那个数的各部分（每个站点、每个数据库、账单里的每项服务…），只有这一层用引用块样式；
  // 状态 = 重置时间、日均可用、数据时间、提示。两层都是一项一行，放不下就省略号，点一下展开
  const ln = (h) => `<p class="ln">${tgHtml(h)}</p>`;
  const detailBlock = (lines) => (lines?.length ? `<blockquote class="bd">${lines.map(ln).join('')}</blockquote>` : '');
  const notesBlock = (lines) => (lines?.length ? `<div class="notes">${lines.map(ln).join('')}</div>` : '');

  // ---------- 每条指标右边的小折线：近 7 天的「滚动 24 小时用量」 ----------
  // 每个整点一个点：从这一刻往前 24 小时一共用了多少（cycle 按月累计、daily 按天重置的用量都这样算，中途清零就从 0 重新累计）；
  // size（存储大小）直接画大小本身。纵轴中心是 7 天的均值（浅色实线），上下对称，所以用量再小也看得出起伏。
  // 虚线是对比线：cycle 是预算（均匀用完额度时每天该用多少 = 100% ÷ 周期天数），daily / size 是上限 100%；
  // 对比线在纵轴范围外时贴着上 / 下边画，顶上一行写明倍数。线按每一段对比线的比例着色（和进度条同一套颜色），
  // 没数据的地方断开，只留一条细点线
  const DAY = 86400;
  const UNIT_FMT = {
    GB: (v) => `${num(v, v < 100 ? 1 : 0)}GB`,
    B: (v) => (v >= 1e12 ? `${num(v / 1e12, 2)}TB` : v >= 1e9 ? `${num(v / 1e9, 2)}GB` : v >= 1e6 ? `${num(v / 1e6, 1)}MB` : v >= 1e3 ? `${num(v / 1e3, 0)}KB` : `${num(v, 0)}B`),
    count: (v) => (v >= 1e6 ? `${num(v / 1e6, 2)}M` : v >= 1e4 ? `${num(v / 1e3, 1)}K` : Math.round(v).toLocaleString('en-US')),
  };
  function absText(pct, m) {
    if (!m.limit) return '';
    const v = (pct / 100) * m.limit;
    if (m.unit === 'GB' || m.unit === 'B') return UNIT_FMT[m.unit](v);
    if (m.unit === '次' || m.unit === '行') return `${UNIT_FMT.count(v)} ${m.unit}`;
    return `${v.toFixed(2)} ${m.unit || ''}`.trim();
  }
  // 每小时的累计值 → 近 7 天每个整点的滚动 24 小时用量 [[t, v 或 null]]
  function rolling(pts, kind) {
    const x0 = nowSec() - 7 * DAY;
    if (!pts?.length) return [];
    if (kind === 'size') return pts.filter(([t]) => t >= x0);
    const inc = [];   // 每个点相对上一个点增加了多少；隔了 3 小时以上算不出来（null）
    for (let i = 1; i < pts.length; i++) {
      const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
      inc.push([t1, t1 - t0 > 3 * 3600 ? null : v1 >= v0 ? v1 - v0 : v1]);   // 变小了 = 中途重置过
    }
    const out = [];
    let j = 0, sum = 0, bad = 0;
    for (let i = 0; i < inc.length; i++) {
      const [t, dv] = inc[i];
      if (dv == null) bad++; else sum += dv;
      while (inc[j][0] <= t - DAY) { if (inc[j][1] == null) bad--; else sum -= inc[j][1]; j++; }
      if (t < x0) continue;
      out.push([t, bad || t - DAY < pts[0][0] ? null : Math.max(0, sum)]);   // 不满 24 小时的数据不算
    }
    return out;
  }
  const ratioCls = (r) => (r < 0.5 ? 1 : r < 0.8 ? 2 : r < 1 ? 3 : r < 1.5 ? 4 : 5);
  const times = (k) => (k >= 10 ? Math.round(k).toLocaleString('en-US') : k >= 1 ? num(k, 1) : num(k, 2));
  const lines = new Map();   // svg id -> 悬停用的数据
  // m：{ kind, days, limit, unit }；pts：这条指标每小时的百分比
  function spark(pts, m) {
    const kind = ['daily', 'size'].includes(m.kind) ? m.kind : 'cycle';
    const ref = kind === 'cycle' ? 100 / (m.days > 0 ? m.days : 30.4) : 100;
    const refName = kind === 'cycle' ? '预算' : '上限';
    const W = 96, TOP = 11, H = 38, ch = H - TOP;
    const now = nowSec(), x0 = now - 7 * DAY;
    const x = (t) => ((t - x0) / (7 * DAY)) * W;
    const ps = rolling(pts, kind);
    const vs = ps.filter((p) => p[1] != null).map((p) => p[1]);
    const id = `l${++chartSeq}`;
    if (!vs.length) {
      return `<svg class="ls" viewBox="0 0 ${W} ${H}" role="img" aria-label="还没有足够的数据">
        <text class="cap" x="${W}" y="8" text-anchor="end">数据不满 24 小时</text>
        <line class="gap" x1="0" x2="${W}" y1="${H - 1}" y2="${H - 1}"/></svg>`;
    }
    const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
    const half = Math.max(Math.max(...vs.map((v) => Math.abs(v - mean))) * 1.15, mean * 0.08, ref * 1e-4);
    const lo = mean - half, hi = mean + half;
    const y = (v) => TOP + ch - ((v - lo) / (hi - lo)) * ch;
    const last = vs[vs.length - 1];
    let refLine, cap;
    if (ref > hi) {
      refLine = TOP; cap = last > 0 ? `▲ ${refName}是当前 ${times(ref / last)} 倍` : `▲ ${refName}在上方 · 当前 0`;
    } else if (ref < lo) {
      refLine = H - 0.5; cap = `▼ 当前是${refName} ${times(last / ref)} 倍`;
    } else {
      refLine = y(ref); cap = `当前是${refName} ${times(last / ref)} 倍`;
    }
    // 同一颜色的连续几段合成一条 path；没数据的地方断开
    let out = '', run = null;
    const flush = () => {
      if (!run) return;
      const d = run.pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
      const [fx] = run.pts[0], [lx] = run.pts[run.pts.length - 1];
      out += `<path class="area s${run.c}" d="${d}L${lx.toFixed(1)},${H}L${fx.toFixed(1)},${H}Z"/><path class="seg s${run.c}" d="${d}"/>`;
      run = null;
    };
    const gaps = [];
    let gapFrom = x0;
    for (let i = 0; i < ps.length; i++) {
      const [t, v] = ps[i];
      if (v == null) { flush(); if (gapFrom == null) gapFrom = ps[i - 1]?.[0] ?? x0; continue; }
      if (gapFrom != null) { if (t - gapFrom > 1.5 * 3600) gaps.push([gapFrom, t]); gapFrom = null; }
      const prev = ps[i - 1];
      if (!prev || prev[1] == null) { flush(); run = { c: ratioCls(v / ref), pts: [[x(t), y(v)]] }; continue; }
      const c = ratioCls(v / ref);
      if (run && run.c !== c) { const p = run.pts[run.pts.length - 1]; flush(); run = { c, pts: [p] }; }
      if (!run) run = { c, pts: [[x(prev[0]), y(prev[1])]] };
      run.pts.push([x(t), y(v)]);
    }
    flush();
    const lastT = ps[ps.length - 1][0];
    if (gapFrom != null || now - lastT > 3 * 3600) gaps.push([gapFrom ?? lastT, now]);
    lines.set(id, { ps, ref, refName, kind, m });
    return `<svg class="ls" viewBox="0 0 ${W} ${H}" data-ls="${id}" role="img" aria-label="近 7 天${kind === 'size' ? '的大小' : '滚动 24 小时用量'}，${esc(cap)}">
      <text class="cap" x="${W}" y="8" text-anchor="end">${esc(cap)}</text>
      <line class="mid" x1="0" x2="${W}" y1="${(TOP + ch / 2).toFixed(1)}" y2="${(TOP + ch / 2).toFixed(1)}"/>
      ${out}
      ${gaps.map(([a, b]) => `<line class="gap" x1="${x(a).toFixed(1)}" x2="${x(b).toFixed(1)}" y1="${H - 1}" y2="${H - 1}"/>`).join('')}
      <line class="ref${ref > hi || ref < lo ? ' out' : ''}" x1="0" x2="${W}" y1="${refLine.toFixed(1)}" y2="${refLine.toFixed(1)}"/>
      <line class="cursor" x1="0" x2="0" y1="${TOP}" y2="${H}" hidden/></svg>`;
  }
  function lineTip(svg, e) {
    const c = lines.get(svg.dataset.ls);
    if (!c) return false;
    const r = svg.getBoundingClientRect();
    const now = nowSec(), t = now - 7 * DAY + ((e.clientX - r.left) / r.width) * 7 * DAY;
    let best = null;
    for (const p of c.ps) if (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    if (!best) return false;
    const cur = svg.querySelector('line.cursor');
    const cx = ((best[0] - (now - 7 * DAY)) / (7 * DAY)) * 96;
    cur.setAttribute('x1', cx); cur.setAttribute('x2', cx); cur.removeAttribute('hidden');
    const [bt, v] = best;
    const pct = (p) => `${num(p, p < 1 ? 3 : 1)}%${c.m.limit ? `（${absText(p, c.m)}）` : ''}`;
    const refTxt = c.kind === 'cycle' ? `预算 ${pct(c.ref)}/天` : `上限 ${pct(100)}`;
    showTip(e, v == null ? `${fullTime(bt)} · 没有数据`
      : `${fullTime(bt)} · ${c.kind === 'size' ? '大小' : '近 24 小时用了'} ${pct(v)} · ${refTxt} · ${times(v / c.ref)} 倍`);
    return true;
  }

  // ---------- traffic-bot：每个来源一张卡（Cloudflare 按 CDN / D1 / Workers 拆成几张） ----------
  // 旧版 bot 只给 TG 原文（html）：第一行标题当副标题，额度那两行（▰▱ + 「└ 用量 / 总量」）已经画成条，去掉，其余照原样显示
  function reportParts(html) {
    let h = String(html || '');
    let sub = '';
    const first = h.match(/^<b>[^\n]*?<\/b>(?:\s*<i>([^\n]*?)<\/i>)?[^\n]*\n?/);
    if (first) { sub = first[1] || ''; h = h.slice(first[0].length); }
    h = h.replace(/^[^\n]*[▰▱][^\n]*\n└ <code>[^\n]*(\n|$)/gm, '')
      .replace(/<blockquote>\s*<\/blockquote>\n?/g, '')
      .replace(/<blockquote>\s+/g, '<blockquote>').replace(/\s+<\/blockquote>/g, '</blockquote>')
      .replace(/^\s+|\s+$/g, '');
    return { sub: tgHtml(sub), body: h ? tgHtml(h) : '' };
  }
  // 卡片标题统一为「厂商 · 名称」两层：Cloudflare · D1、AWS · CloudFront、AlibabaCloud · CDT…
  // 新版 bot 直接给 group / name；兼容老版（name 是「Cloudflare · D1」或「AWS 账单」这种）
  const LEGACY = { BWH: ['BandwagonHost', 'VPS'], Lightsail: ['AWS', 'Lightsail'], CloudFront: ['AWS', 'CloudFront'],
    'AWS 账单': ['AWS', '账单'], 'Oracle Cloud': ['OracleCloud', '用量'], 'Aliyun CDT': ['AlibabaCloud', 'CDT'] };
  function names(p) {
    if (p.group && p.name.startsWith(`${p.group} · `)) return [p.group, p.name.slice(p.group.length + 3)];
    if (p.group) return [p.group, p.name];
    return LEGACY[p.name] || ['', p.name];
  }
  // 指标名去掉和标题重复的厂商前缀：「Cloudflare Workers/Pages 今日请求」→「今日请求」
  const LABEL_PREFIX = /^(BWH|CloudFront|AWS|Oracle|Cloudflare|Lightsail|阿里云 CDT|阿里云|D1|R2|Workers\/Pages)\s+/;
  const shortLabel = (l) => { let x = l; for (let i = 0; i < 3; i++) x = x.replace(LABEL_PREFIX, ''); return x.replace(/（[^）]*）$/, '') || l; };
  const tbTitle = (group, name, sub) =>
    `${group ? `<span class="grp">${esc(group)}</span>` : ''}${esc(name)}${sub ? `<span class="sub">${sub}</span>` : ''}`;
  // 旧版 bot 没给 kind：按天重置的（D1 读写、Workers 请求）和存储大小按 level 算，其余按月累计
  // 没给 kind 的旧版 bot，以及上一版的 level（按天重置和存储大小没分开）：按指标名判断
  const guessKind = (key) => (/:(d1_storage|d1_db:.*|r2_storage)$/.test(key) ? 'size' : /:(workers|d1_read|d1_write)$/.test(key) ? 'daily' : 'cycle');
  // 一条指标：第一行 名称 · 用量 / 总量 · 百分比，第二行 额度条；右边两行高的 7 根小柱
  const metricRow = (label, detail, pct, sparkSvg, marks = []) => `<div class="metric">
      <span class="metric-label" title="${esc(label)}">${esc(label)}</span>
      <span class="metric-detail num">${esc(detail)}</span>
      <span class="metric-pct num${pct >= 95 ? ' l5' : pct >= 80 ? ' l4' : ''}">${num(pct, 1)}%</span>
      <div class="metric-bar">${bar(pct, marks)}</div>
      ${sparkSvg}
    </div>`;

  // traffic-bot：每个来源一张卡 → [{ group, html }]
  function trafficItems(src, hist, hideAliyun) {
    return (src.data?.providers || []).filter((p) => !p.empty).map((p) => {
      const [group, name] = names(p);
      if (hideAliyun && group === 'AlibabaCloud') return null;   // 有 cdt-guard 自己的卡片时以它为准
      // 账号总量在前，单个数据库 / 实例的在后
      const ms = [...(p.metrics || [])].sort((a, b) => (/:d1_db:|:db:/.test(a.key) ? 1 : 0) - (/:d1_db:|:db:/.test(b.key) ? 1 : 0));
      const isAlert = (m) => m.alert || !m.detail;
      const rows = ms.map((m) => (isAlert(m)
        ? (m.pct > 0 ? `<div class="alert-row"><span class="badge warn">提醒</span>${esc(m.label)}</div>` : '')
        : metricRow(shortLabel(m.label), m.detail, m.pct, spark(hist[m.key], { ...m, kind: ['cycle', 'daily', 'size'].includes(m.kind) ? m.kind : guessKind(m.key) })))).join('');
      let sub, rest;
      if (Array.isArray(p.detail) || Array.isArray(p.notes)) {
        sub = tgHtml(p.sub || '');
        rest = detailBlock(p.detail) + notesBlock(p.notes);
      } else {   // 旧版 bot
        const rep = reportParts(p.html);
        sub = rep.sub;
        rest = rep.body ? `<div class="tg">${rep.body}</div>` : '';
      }
      const body = rows + rest || '<p class="ln muted">–</p>';
      return { group, html: card(src, tbTitle(group, name, sub), p.ok ? '' : '<span class="badge bad">查询失败</span>', body, '', { cls: 'tb' }) };
    }).filter(Boolean);
  }

  // 重置时间：「10天后重置 (Nov.1 00:00:00)」，和 TG 消息同一种写法
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function resetText(ms, offHours) {   // ms：重置时刻；offHours：按哪个时区显示
    const h = (ms - Date.now()) / 3600e3;
    const left = h < 48 ? `${Math.max(0, Math.round(h))}小时` : `${Math.ceil(h / 24)}天`;
    const d = new Date(ms + offHours * 3600e3);
    const p2 = (n) => String(n).padStart(2, '0');
    return `${left}后重置 <i>(${MON[d.getUTCMonth()]}.${d.getUTCDate()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())})</i>`;
  }

  // cdt-guard：和 traffic-bot 的卡片同一种三层样式 → { group, html }
  function cdtItem(src, hist) {
    const d = src.data || {};
    const quota = d.quota_gb || 0, limit = d.limit_gb || 0, used = d.used_gb || 0;
    const [gc, gt] = d.cost_locked ? ['bad', '费用熔断'] : d.locked ? ['bad', '流量熔断'] : d.hold ? ['warn', '暂停自启'] : ['ok', '守护中'];
    // CDT 免费额度按北京时间自然月重置
    const cn = new Date(Date.now() + 8 * 3600e3);
    const start = Date.UTC(cn.getUTCFullYear(), cn.getUTCMonth(), 1) - 8 * 3600e3;
    const reset = Date.UTC(cn.getUTCFullYear(), cn.getUTCMonth() + 1, 1) - 8 * 3600e3;
    const days = (reset - start) / 86400e3;
    const daysLeft = Math.max(1, Math.ceil((reset - Date.now()) / 86400e3));
    const toLimit = Math.max(0, limit - used);
    const pct = quota ? (used / quota) * 100 : 0;
    const costPct = d.cost_limit ? ((d.cost || 0) / d.cost_limit) * 100 : 0;
    const regions = Object.entries(d.by_region || {});
    const gb = (v) => `${num(v, v < 100 ? 1 : 0)}GB`;
    const asPct = (pts, total) => (pts && total ? pts.map(([t, v]) => [t, (v / total) * 100]) : null);
    const rows = metricRow('流量', `${num(used, 1)} / ${num(quota, 0)}GB`, pct,
      spark(asPct(hist.used_gb, quota), { kind: 'cycle', days, limit: quota, unit: 'GB' }),
      limit && quota ? [[(limit / quota) * 100, '']] : [])
      + (d.cost_limit ? metricRow('本月费用', `${num(d.cost, 2)} / ${num(d.cost_limit, 0)} ${d.currency || ''}`, costPct,
        spark(asPct(hist.cost, d.cost_limit), { kind: 'cycle', days, limit: d.cost_limit, unit: d.currency || 'USD' })) : '');
    const detail = regions.length > 1 ? regions.sort().map(([r, g]) => `🗺 ${esc(r)} · ${esc(gb(g))}`) : [];
    const notes = [
      `🛡 熔断线 <b>${esc(gb(limit))}</b>（${d.mode === 'sg' ? '安全组封禁' : '关机'}）· 距熔断 <b>${esc(gb(toLimit))}</b>`,
      `🖥 <b>${esc(d.name || 'ECS')}</b> · ${esc(d.status || '?')} · 速率 ${esc(num(d.rate_gbh, 2))}GB/h`,
      `🔄 ${resetText(reset, 8)} · 日均可用 <b>${esc(gb(toLimit / daysLeft))}</b>`,
      d.fail ? `⚠️ <b>最近 ${esc(d.fail)} 次查询阿里云失败</b>：${esc(d.last_error || '')}` : '',
      d.cost_error ? `⚠️ <b>账单查询失败，费用熔断暂时失效</b>：${esc(d.cost_error)}` : '',
    ].filter(Boolean);
    const pool = d.cls === 'international' ? '本月 · 海外/香港' : '本月 · 中国内地';
    const badges = `<span class="badge ${gc} keep-case">cdt-guard ${gt}</span>`;
    return { group: 'AlibabaCloud', html: card(src, tbTitle('AlibabaCloud', 'CDT', esc(pool)), badges, rows + detailBlock(detail) + notesBlock(notes), '', { cls: 'tb' }) };
  }

  // ---------- cfst-ddns：每个目标一张卡，行数固定 ----------
  const KIND = { updated: ['info', '已切换'], unchanged: ['ok', '无变化'], healthy: ['ok', '巡检正常'], failed: ['bad', '失败'] };
  const MODE = { check: '巡检', pool: '复测榜单', full: '全量扫描' };
  function cfstCard(src, hist) {
    const d = src.data || {};
    const [kc, kl] = KIND[d.kind] || ['ink', d.kind || '?'];
    const failed = d.kind === 'failed';
    const colo = d.kind === 'updated' && d.old_colo && d.old_colo !== d.colo
      ? `<b>${esc(d.old_colo)}</b><i>→</i><b>${esc(d.colo || '?')}</b>` : `<b>${esc(d.colo || '?')}</b>`;
    const hero = `<div class="hero">
        <div class="big colo${d.kind === 'updated' && d.old_colo && d.old_colo !== d.colo ? ' sw' : ''}">${colo}${d.kind === 'updated' && d.old_colo && d.old_colo !== d.colo ? '' : `<span>${failed ? '解析未变' : '机房'}</span>`}</div>
        ${stats([
          [d.metric || '速度', failed ? '–' : (d.metric ? `<span class="num">${num(d.speed, 2)}</span> <small>MB/s</small>` : '–')],
          ['延迟', failed ? '–' : `<span class="num">${num(d.lat, 0)}</span> <small>ms${d.group ? ` ${esc(d.group.replace(/ ?段$/, '').replace(/ms$/, ''))}` : ''}</small>`],
          ['丢包', failed ? '–' : `<span class="num">${num(d.loss, 2)}</span>`],
          ['来源', failed ? '–' : esc(d.src || '–')],
        ])}
      </div>`;
    // 榜单固定 5 行，不足的补空行，卡片高度不随数据变
    const rows = (d.top || []).slice(0, 5);
    while (rows.length < 5) rows.push(null);
    const ageTop = d.top_ts && d.mode === 'check' && d.top?.length ? ` · ${ago(d.top_ts)}` : '';
    const top = `<table class="top">
      <thead><tr><th>#</th><th>机房</th><th>ms</th><th>${d.metric ? 'MB/s' : '丢包'}</th><th>段</th><th>来源</th><th class="cap">榜单${esc(ageTop)}</th></tr></thead><tbody>
      ${rows.map((r, i) => (r ? `<tr class="${r.mark}"><td>${i + 1}</td><td>${esc(r.colo)}</td><td>${num(r.lat, 0)}</td>
        <td>${d.metric ? num(r.speed, 2) : num(r.loss, 2)}</td><td>${esc(r.group)}</td><td>${esc(r.src)}</td>
        <td class="mark">${r.mark === 'pick' ? '◀ 选用' : r.mark === 'old' ? '原' : ''}</td></tr>`
        : `<tr class="pad"><td colspan="7">${i === 0 ? '榜单在下一次复测榜单 / 全量扫描后出现（巡检只测当前 IP）' : ''}</td></tr>`)).join('')}
      </tbody></table>`;
    const body = hero
      + line(failed ? '⚠️' : '💡', failed ? d.reason : d.why, failed ? 'bad' : '')
      + line('🆚', d.compare || (d.kind === 'failed' ? '' : '官方 / 种子对比在下一次复测榜单或全量扫描后更新'), 'muted')
      + top
      + charts2(d.metric ? chart(hist.speed, { label: d.metric, unit: ' MB/s', color: 'var(--accent-green)', min: 0, digits: 2 })
                         : chart(hist.loss, { label: '丢包', color: 'var(--accent-green)', min: 0, digits: 2 }),
                chart(hist.lat, { label: '延迟', unit: ' ms', color: 'var(--accent-orange)', digits: 0 }))
      + line('🔎', d.scan, 'muted small')
      + line('⚙️', d.params, 'muted small');
    const badges = `<span class="badge ${kc}">${kl}</span>${d.peak ? '<span class="badge ink">晚高峰</span>' : ''}`;
    const foot = `<span>${esc(d.path || MODE[d.mode] || '')}</span><span>${d.elapsed ? `用时 ${esc(d.elapsed)}s` : ''}</span>`;
    return card(src, esc(d.label || src.source.split(':')[1] || 'cfst'), badges, body, foot, { cls: 'cfst' });
  }

  // ---------- 账单汇总（顶部两格） ----------
  // 来源：traffic-bot 上报的 AWS（CloudWatch 预估账单，按 UTC 自然月）、cdt-guard 的阿里云费用（按北京时间自然月）。
  // 预计月底 = 已产生 ÷ 本月已过去的比例（线性外推）；月初第一天数据太少，不外推
  const SYM = { USD: '$', CNY: '¥', EUR: '€', JPY: '¥', HKD: 'HK$' };
  const TZ_OFF = { UTC: 0, 'Asia/Shanghai': 8 };
  function monthFraction(tz) {
    const off = (TZ_OFF[tz] ?? 0) * 3600e3;
    const local = new Date(Date.now() + off);
    const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - off;
    const end = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - off;
    return (Date.now() - start) / (end - start);
  }
  function collectBills(sources) {
    const out = [];
    for (const s of sources) {
      if (s.source === 'traffic-bot') for (const b of s.data?.bills || []) out.push(b);
      if (s.source === 'cdt-guard' && s.data?.cost_limit > 0) {  // 设了费用熔断线才会去查账单
        out.push({ name: '阿里云', amount: Number(s.data.cost) || 0, currency: s.data.currency || 'USD', tz: 'Asia/Shanghai' });
      }
    }
    return out.filter((b) => Number.isFinite(b.amount));
  }
  const money = (byCur) => Object.entries(byCur).map(([c, v]) => `${SYM[c] || `${c} `}${v.toFixed(2)}`).join(' + ') || '–';
  function renderBills(sources) {
    const bills = collectBills(sources);
    const now = {}, proj = {}; let projOk = bills.length > 0;
    const lines = [];
    for (const b of bills) {
      const f = monthFraction(b.tz);
      now[b.currency] = (now[b.currency] || 0) + b.amount;
      const p = f >= 1 / 31 ? b.amount / f : null;
      if (p == null) projOk = false; else proj[b.currency] = (proj[b.currency] || 0) + p;
      lines.push(`${b.name}：${money({ [b.currency]: b.amount })}，预计 ${p == null ? '–（月初数据太少）' : money({ [b.currency]: p })}`);
    }
    $('#st-bill').textContent = bills.length ? money(now) : '–';
    $('#st-proj').textContent = projOk ? money(proj) : '–';
    const tipText = bills.length ? `${lines.join('\n')}\n预计按本月已过去的时间线性外推，账单本身有几小时延迟`
      : '没有账单数据：traffic-bot 需要开启 AWS 账单，cdt-guard 需要设置费用熔断线（COST_LIMIT）';
    $('#st-bill-box').title = tipText; $('#st-proj-box').title = tipText;
  }

  // ---------- 页面 ----------
  const state = { status: null, history: {}, error: '', loadedAt: 0 };

  // ---------- 排版：所有卡片定宽（不小于 360px）进同一个瀑布流 ----------
  // 页面越宽列数越多，卡片不会被拉得很宽；每张卡放进当前最矮的那一列，列底不留大块空白。
  // 同一厂商的卡（Cloudflare 的几张）当成一组放在同一列，组太高（超过平均列高的 1.15 倍）时才拆开；
  // 每列里按原来的顺序（额度在前、优选 IP 在后）从上往下排
  const COL_MIN = 360, GAP = 16;
  function masonry() {
    const box = document.querySelector('.mason');
    if (!box) return;
    const cards = [...box.querySelectorAll('.card')].sort((a, b) => a.dataset.i - b.dataset.i);
    const n = Math.max(1, Math.floor((box.clientWidth + GAP) / (COL_MIN + GAP)));
    const cols = Array.from({ length: n }, () => Object.assign(document.createElement('div'), { className: 'col' }));
    box.replaceChildren(...cols);
    cards.forEach((c) => cols[0].appendChild(c));             // 先放进同宽的一列里量高度
    if (n === 1) { fitSubs(); return; }
    const hOf = new Map(cards.map((c) => [c, c.offsetHeight + GAP]));
    const total = cards.reduce((a, c) => a + hOf.get(c), 0);
    // 连续的同组卡片合成一组
    const units = [];
    for (const c of cards) {
      const last = units[units.length - 1];
      if (last && c.dataset.g && last[0].dataset.g === c.dataset.g) last.push(c); else units.push([c]);
    }
    const sum = (u) => u.reduce((a, c) => a + hOf.get(c), 0);
    const pieces = units.flatMap((u) => (u.length > 1 && sum(u) > (total / n) * 1.15 ? u.map((c) => [c]) : [u]));
    pieces.sort((a, b) => sum(b) - sum(a));                    // 先放高的，最后的高度差最小
    const height = new Array(n).fill(0), bins = cols.map(() => []);
    for (const u of pieces) {
      const k = height.indexOf(Math.min(...height));
      bins[k].push(...u); height[k] += sum(u);
    }
    bins.forEach((b, k) => b.sort((x, y) => x.dataset.i - y.dataset.i).forEach((c) => cols[k].appendChild(c)));
    fitSubs();
  }
  // 卡头放不下时，副标题被挤得只剩一两个字就整段不显示（悬停卡名能看到）
  function fitSubs() {
    document.querySelectorAll('.card.tb h3 .sub').forEach((s) => {
      s.hidden = false;
      if (s.scrollWidth > s.clientWidth && s.clientWidth < 56) { s.hidden = true; s.closest('h3').title = s.textContent; }
    });
  }
  let resizeTimer = 0, lastW = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (window.innerWidth !== lastW) { lastW = window.innerWidth; masonry(); } }, 150);
  });
  document.fonts?.ready?.then(() => masonry());

  function render() {
    charts.clear(); lines.clear(); chartSeq = 0;
    const main = $('#main');
    if (!API) {
      main.innerHTML = `<div class="empty"><h2>还没有配置 API 地址</h2>
        <p>运行 <code>./init.sh</code> 会把 Worker 地址写进 <code>web/config.js</code>；<br>也可以在网址后加 <code>?api=https://你的Worker地址</code> 临时指定。</p></div>`;
      return;
    }
    if (!state.status) {
      if (state.error) main.innerHTML = `<div class="empty"><h2>读取失败</h2><p>${esc(state.error)}</p></div>`;
      return;
    }
    const sources = state.status.sources || [];
    const hist = (id) => state.history[id] || {};
    const by = (pred) => sources.filter((s) => pred(s.source));
    const cdt = by((id) => id === 'cdt-guard');
    const tb = by((id) => id === 'traffic-bot');
    const cfst = by((id) => id.startsWith('cfst-ddns:'));
    const known = new Set([...cdt, ...tb, ...cfst]);
    const other = sources.filter((s) => !known.has(s));

    // 统计条
    const offline = sources.filter(isOffline).length;
    const thresholds = tb[0]?.data?.thresholds || [80, 95];
    const hot = tb.flatMap((s) => s.data?.providers || []).flatMap((p) => p.metrics || [])
      .filter((m) => (m.alert || !m.detail ? m.pct > 0 : m.pct >= Math.min(...thresholds))).length;
    $('#st-online').textContent = sources.length - offline;
    $('#st-offline').textContent = offline;
    $('#st-hot').textContent = hot;
    renderBills(sources);
    $('#st-last').textContent = sources.length ? ago(Math.max(...sources.map((s) => s.ts))).replace(' 前', '').replace('前', '') : '–';

    let html = state.error ? `<div class="banner">刷新失败：${esc(state.error)}（显示的是上次的数据）</div>` : '';
    const items = [
      ...tb.flatMap((s) => trafficItems(s, hist(s.source), cdt.length > 0)),
      ...cdt.map((s) => cdtItem(s, hist(s.source))),
      ...cfst.map((s) => ({ group: '', html: cfstCard(s, hist(s.source)) })),
      ...other.map((s) => ({ group: '', html: card(s, esc(s.source), '<span class="badge ink">未识别</span>', `<pre class="tg">${esc(JSON.stringify(s.data, null, 2))}</pre>`) })),
    ];
    if (!sources.length) {
      html = `<div class="empty"><h2>还没有任何上报</h2>
        <p>在 traffic-bot、cdt-guard、cfst-ddns 的配置里填上 <code>SONDE_URL</code> 和 <code>SONDE_TOKEN</code>，<br>它们下一次运行后就会出现在这里。</p></div>`;
    } else {
      // 每张卡标上顺序和厂商，瀑布流按这两项分列
      html += `<div class="legend"><span><i class="lg-bar"></i>额度已用</span>
        <span><svg class="lg-ls" viewBox="0 0 30 14" aria-hidden="true"><line class="mid" x1="0" x2="30" y1="8" y2="8"/><line class="ref" x1="0" x2="30" y1="3" y2="3"/><path class="seg s1" d="M0,11L8,9L14,10L20,7"/><path class="seg s4" d="M20,7L26,3L30,1"/></svg>近 7 天每个整点往前 24 小时的用量（存储类为大小）：中间浅线是 7 天均值，虚线是预算（按天重置和存储类为上限），越接近 / 超过越偏橙红，断开是没数据</span>
        <span><i class="lg-bd"></i>明细：上面的数由哪几部分组成</span></div>`
        + `<div class="mason">${items.map((it, i) => it.html.replace('<article ', `<article data-i="${i}" data-g="${esc(it.group || '')}" `)).join('')}</div>`;
    }
    main.innerHTML = html;
    lastW = window.innerWidth;
    masonry();
    $('#ft-updated').textContent = `更新于 ${fullTime(nowSec())}`;
  }

  async function getJSON(path) {
    const r = await fetch(`${API}${path}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  let lastHistory = 0;
  async function load(force = false) {
    if (!API) { render(); return; }
    try {
      const jobs = [getJSON('/api/status')];
      if (force || Date.now() - lastHistory >= HISTORY_MS) jobs.push(getJSON('/api/history'));
      const [st, hi] = await Promise.all(jobs);
      state.status = st;
      if (hi) { state.history = hi.series || {}; lastHistory = Date.now(); }
      state.error = '';
    } catch (e) {
      state.error = e.message === 'Failed to fetch' ? '连不上 Worker（网络问题，或地址不对）' : e.message;
    }
    state.loadedAt = Date.now();
    render();
  }

  // 点一下省略的那一行：展开全文 / 收起
  document.addEventListener('click', (e) => { const l = e.target.closest('.line, .ln'); if (l) l.classList.toggle('open'); });

  // ---------- 配色菜单 ----------
  const menu = $('#theme-menu');
  const themeBtn = $('#btn-theme');
  const currentScheme = () => document.documentElement.dataset.scheme || DEFAULT_SCHEME;
  function applyScheme(s) {
    document.documentElement.dataset.scheme = s;
    store.set('sonde.scheme', s);
    renderMenu();
  }
  function renderMenu() {
    const item = (k) => {
      const [label, paper, accent] = SCHEMES[k];
      return `<button class="theme-item" role="menuitemradio" aria-checked="${k === currentScheme()}" data-scheme="${k}">
        <span class="swatch" style="--sw-paper:${paper};--sw-accent:${accent}"><i></i><i></i></span><span>${esc(label)}</span></button>`;
    };
    const keys = Object.keys(SCHEMES);
    menu.innerHTML = `<div class="theme-menu-head">配色</div><div class="theme-menu-cols">
      <div><div class="theme-menu-label">LIGHT</div>${keys.filter((k) => k.endsWith('-light')).map(item).join('')}</div>
      <div><div class="theme-menu-label">DARK</div>${keys.filter((k) => k.endsWith('-dark')).map(item).join('')}</div></div>`;
  }
  function placeMenu() {
    const r = themeBtn.getBoundingClientRect();
    menu.style.top = `${r.bottom + 8}px`;
    menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
  }
  const closeMenu = () => { menu.hidden = true; themeBtn.setAttribute('aria-expanded', 'false'); };
  themeBtn.addEventListener('click', () => {
    const open = menu.hidden;
    if (open) { renderMenu(); menu.hidden = false; placeMenu(); } else menu.hidden = true;
    themeBtn.setAttribute('aria-expanded', String(open));
  });
  menu.addEventListener('click', (e) => { const b = e.target.closest('[data-scheme]'); if (b) applyScheme(b.dataset.scheme); });
  document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('#theme-menu, #btn-theme')) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { closeMenu(); themeBtn.focus(); } });
  window.addEventListener('resize', () => { if (!menu.hidden) placeMenu(); });
  if (!SCHEMES[currentScheme()]) document.documentElement.dataset.scheme = DEFAULT_SCHEME;

  // ---------- 启动 ----------
  // 每 30 秒读一次 Worker 里的最新数据（切回页面时立即补读）。没有「立即刷新」按钮：
  // 读到的只是工具上次上报的结果，按钮并不能让工具重新测速，30 秒的自动刷新已经够了
  load(true);
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    // 点开了某一行全文时不重绘，免得刚展开就被收起
    if (document.querySelector('.line.open, .ln.open')) return;
    if (Date.now() - state.loadedAt >= STATUS_MS - 1000) load();
  }, 5000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - state.loadedAt > 10_000) load();
  });
})();
