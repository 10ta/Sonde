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

  // 额度行右侧的「近 7 天走势」小图：纵轴从 0 到 max(最高值, 10%)，用量很低的不会被放大成大起伏。数据不够（少于 6 个小时）或这几天几乎没变化（波动不到 1 个百分点）时不画：
  // 一条贴着底的平线什么也说明不了，只会让每张卡看起来一样
  function spark(pts, color) {
    if (!pts || pts.length < 6) return '';
    const vs = pts.map(([, v]) => clamp(v, 0, 100));
    const lo = Math.min(...vs), hi = Math.max(...vs);
    if (hi - lo < 1) return '';
    const x0 = pts[0][0], x1 = pts[pts.length - 1][0];
    const days = Math.max(1, Math.round((x1 - x0) / 86400));
    return `<span class="spark-box" title="近 ${days} 天走势：${num(lo, 1)}% → ${num(vs[vs.length - 1], 1)}%（最高 ${num(hi, 1)}%）">
      <svg class="spark" viewBox="0 0 64 18" preserveAspectRatio="none" aria-hidden="true">
      <path d="${pathOf(pts.map(([t], i) => [t, vs[i]]), 64, 18, 0, Math.max(hi, 10), x0, x1)}" style="stroke:${color}"/></svg></span>`;
  }

  // 近 7 天曲线，悬停看每个小时的值（紧凑版：一行标题 + 44px 高的曲线，固定高度）
  function chart(pts, { label, unit = '', color = 'var(--accent-blue)', min = null, digits = 1 }) {
    const id = `c${++chartSeq}`;
    const H = 44;
    if (!pts || pts.length < 2) {
      return `<div class="chart"><div class="chart-head"><span>${esc(label)} · 7 天</span><span>数据还不够</span></div><svg viewBox="0 0 300 ${H}"></svg></div>`;
    }
    const vals = pts.map((p) => p[1]);
    let lo = min ?? Math.min(...vals), hi = Math.max(...vals);
    if (hi === lo) { hi += 1; lo = Math.max(min ?? -Infinity, lo - 1); }
    const pad = (hi - lo) * 0.08; hi += pad; if (min == null) lo -= pad;
    const x1 = nowSec(), x0 = x1 - 7 * 86400;
    const line = pathOf(pts, 300, H, lo, hi, x0, x1);
    const firstX = (((pts[0][0] - x0) / (x1 - x0)) * 300).toFixed(1);
    const lastX = (((pts[pts.length - 1][0] - x0) / (x1 - x0)) * 300).toFixed(1);
    charts.set(id, { pts, unit, label, digits, lo, hi, x0, x1 });
    const days = [1, 2, 3, 4, 5, 6].map((d) => `<line class="grid" x1="${d * 300 / 7}" x2="${d * 300 / 7}" y1="0" y2="${H}"/>`).join('');
    return `<div class="chart">
      <div class="chart-head"><span>${esc(label)}</span><span><b>${num(Math.min(...vals), digits)}</b>–<b>${num(Math.max(...vals), digits)}</b>${esc(unit)}</span></div>
      <svg viewBox="0 0 300 ${H}" preserveAspectRatio="none" data-chart="${id}" role="img" aria-label="${esc(label)}近 7 天曲线">
        ${days}
        <path class="area" d="${line}L${lastX},${H}L${firstX},${H}Z" style="fill:${color}"/>
        <path class="line" d="${line}" style="stroke:${color}"/>
        <line class="cursor" x1="0" x2="0" y1="0" y2="${H}" hidden/>
      </svg></div>`;
  }
  const charts2 = (a, b) => `<div class="charts">${a}${b}</div>`;

  const tip = $('#chart-tip');
  document.addEventListener('pointermove', (e) => {
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
    tip.textContent = `${fullTime(best[0])}  ${num(best[1], c.digits)}${c.unit}`;
    tip.hidden = false;
    tip.style.left = `${clamp(e.clientX + 12, 8, window.innerWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${e.clientY - 36}px`;
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

  // ---------- traffic-bot：每个来源一张卡（Cloudflare 按 CDN / D1 / Workers 拆成几张） ----------
  // 报告原文是 TG 消息的排版。额度那几行（▰▱ 进度条 + 「└ 用量 / 总量」）已经画成了上面的条，这里去掉；
  // 第一行标题拿来当卡片副标题；其余（重置时间、日均可用、每个数据库、每个站点…）全部照原样显示
  function reportParts(html) {
    let h = String(html || '');
    let sub = '';
    const first = h.match(/^<b>[^\n]*?<\/b>(?:\s*<i>([^\n]*?)<\/i>)?[^\n]*\n?/);
    if (first) { sub = first[1] || ''; h = h.slice(first[0].length); }
    h = h.replace(/^[^\n]*[▰▱][^\n]*\n└ <code>[^\n]*(\n|$)/gm, '')
      .replace(/<\/?blockquote>/g, '\n')        // TG 的引用块在卡片里不用：说明行统一一种样式
      .replace(/\n{2,}/g, '\n')
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
  const shortLabel = (l) => { let x = l; for (let i = 0; i < 3; i++) x = x.replace(LABEL_PREFIX, ''); return x || l; };
  const tbTitle = (group, name, sub) =>
    `${group ? `<span class="grp">${esc(group)}</span>` : ''}${esc(name)}${sub ? `<span class="sub">${sub}</span>` : ''}`;
  const metricRow = (label, detail, pct, spk, marks = []) => `<div class="metric">
      <span class="metric-label" title="${esc(label)}">${esc(label)}</span>
      <span class="metric-detail num">${esc(detail)}</span>
      <span class="metric-pct num${pct >= 95 ? ' l5' : pct >= 80 ? ' l4' : ''}">${num(pct, 1)}%</span>
      <div class="metric-bar">${bar(pct, marks)}${spark(spk, `var(--sig-${level(pct)})`)}</div>
    </div>`;

  // traffic-bot：每个来源一张卡 → [{ group, html }]
  function trafficItems(src, hist, hideAliyun) {
    return (src.data?.providers || []).filter((p) => !p.empty).map((p) => {
      const [group, name] = names(p);
      if (hideAliyun && group === 'AlibabaCloud') return null;   // 有 cdt-guard 自己的卡片时以它为准
      // 账号总量在前，单个数据库 / 实例的在后
      const ms = [...(p.metrics || [])].sort((a, b) => (/:d1_db:|:db:/.test(a.key) ? 1 : 0) - (/:d1_db:|:db:/.test(b.key) ? 1 : 0));
      const rows = ms.map((m) => (m.alert
        ? (m.pct > 0 ? `<div class="alert-row"><span class="badge warn">提醒</span>${esc(m.label)}</div>` : '')
        : metricRow(shortLabel(m.label), m.detail, m.pct, hist[m.key]))).join('');
      const rep = reportParts(p.html);
      const body = rows + (rep.body ? `<div class="tg">${rep.body}</div>` : '') || '<p class="line muted">–</p>';
      return { group, html: card(src, tbTitle(group, name, rep.sub), p.ok ? '' : '<span class="badge bad">查询失败</span>', body, '', { age: false, cls: 'tb' }) };
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

  // cdt-guard：和 traffic-bot 的卡片同一种样式，放在「额度」里 → { group, html }
  function cdtItem(src, hist) {
    const d = src.data || {};
    const quota = d.quota_gb || 0, limit = d.limit_gb || 0, used = d.used_gb || 0;
    const [gc, gt] = d.cost_locked ? ['bad', '费用熔断'] : d.locked ? ['bad', '流量熔断'] : d.hold ? ['warn', '暂停自启'] : ['ok', '守护中'];
    // CDT 免费额度按北京时间自然月重置
    const cn = new Date(Date.now() + 8 * 3600e3);
    const reset = Date.UTC(cn.getUTCFullYear(), cn.getUTCMonth() + 1, 1) - 8 * 3600e3;
    const daysLeft = Math.max(1, Math.ceil((reset - Date.now()) / 86400e3));
    const toLimit = Math.max(0, limit - used);
    const pct = quota ? (used / quota) * 100 : 0;
    const costPct = d.cost_limit ? ((d.cost || 0) / d.cost_limit) * 100 : 0;
    const regions = Object.entries(d.by_region || {});
    const gb = (v) => `${num(v, v < 100 ? 1 : 0)}GB`;
    const rows = metricRow('流量', `${num(used, 1)} / ${num(quota, 0)}GB`, pct,
      hist.used_gb && quota ? hist.used_gb.map(([t, v]) => [t, (v / quota) * 100]) : null,
      limit && quota ? [[(limit / quota) * 100, '']] : [])
      + (d.cost_limit ? metricRow('本月费用', `${num(d.cost, 2)} / ${num(d.cost_limit, 0)} ${d.currency || ''}`, costPct,
        hist.cost ? hist.cost.map(([t, v]) => [t, (v / d.cost_limit) * 100]) : null) : '');
    const lines = [
      `🛡 熔断线 <b>${esc(gb(limit))}</b>（${d.mode === 'sg' ? '安全组封禁' : '关机'}）· 距熔断 <b>${esc(gb(toLimit))}</b>`,
      `🖥 <b>${esc(d.name || 'ECS')}</b> · ${esc(d.status || '?')} · 速率 ${esc(num(d.rate_gbh, 2))}GB/h`,
      regions.length > 1 ? `🗺 ${regions.map(([r, g]) => `${esc(r)} ${esc(gb(g))}`).join(' · ')}` : '',
      `🔄 ${resetText(reset, 8)} · 日均可用 <b>${esc(gb(toLimit / daysLeft))}</b>`,
      d.fail ? `⚠️ <b>最近 ${esc(d.fail)} 次查询阿里云失败</b>：${esc(d.last_error || '')}` : '',
      d.cost_error ? `⚠️ <b>账单查询失败，费用熔断暂时失效</b>：${esc(d.cost_error)}` : '',
    ].filter(Boolean).map(emo).join('\n');
    const pool = d.cls === 'international' ? '本月 · 海外/香港' : '本月 · 中国内地';
    const badges = `<span class="badge ${gc} keep-case">cdt-guard ${gt}</span>`;
    return { group: 'AlibabaCloud', html: card(src, tbTitle('AlibabaCloud', 'CDT', esc(pool)), badges, `${rows}<div class="tg">${lines}</div>`, '', { cls: 'tb' }) };
  }

  // 额度区排版：卡片最多的那个厂商（比如 Cloudflare 拆成的几张）连着排一列，其他卡片在旁边按瀑布流排
  function quotaLayout(items) {
    const count = {};
    for (const it of items) if (it.group) count[it.group] = (count[it.group] || 0) + 1;
    const [big] = Object.entries(count).sort((a, b) => b[1] - a[1])[0] || [];
    const stackGroup = big && count[big] >= 3 ? big : null;
    const stack = items.filter((it) => it.group === stackGroup).map((it) => it.html).join('');
    const rest = items.filter((it) => it.group !== stackGroup).map((it) => it.html).join('');
    if (!stack) return `<div class="masonry">${rest}</div>`;
    if (!rest) return `<div class="tb-stack">${stack}</div>`;
    return `<div class="tb-layout"><div class="tb-stack">${stack}</div><div class="masonry">${rest}</div></div>`;
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
        <div class="big colo">${colo}${d.kind === 'updated' && d.old_colo && d.old_colo !== d.colo ? '' : `<span>${failed ? '解析未变' : '机房'}</span>`}</div>
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
      + charts2(d.metric ? chart(hist.speed, { label: `${d.metric} MB/s`, color: 'var(--accent-green)', min: 0, digits: 2 })
                         : chart(hist.loss, { label: '丢包', color: 'var(--accent-green)', min: 0, digits: 2 }),
                chart(hist.lat, { label: '延迟 ms', color: 'var(--accent-orange)', digits: 0 }))
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

  function section(title, note, cards, layout = 'grid', extra = '') {
    if (!cards) return '';
    const cls = layout === 'raw' ? '' : layout === 'wide' ? 'grid grid-wide' : 'grid';
    return `<section class="section"><div class="sec-head"><h2>${title}</h2><span class="sec-note">${note}</span>${extra}</div>
      <div class="${cls}">${cards}</div></section>`;
  }

  function render() {
    charts.clear(); chartSeq = 0;
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
      .filter((m) => (m.alert ? m.pct > 0 : m.pct >= Math.min(...thresholds))).length;
    $('#st-online').textContent = sources.length - offline;
    $('#st-offline').textContent = offline;
    $('#st-hot').textContent = hot;
    renderBills(sources);
    $('#st-last').textContent = sources.length ? ago(Math.max(...sources.map((s) => s.ts))).replace(' 前', '').replace('前', '') : '–';

    let html = state.error ? `<div class="banner">刷新失败：${esc(state.error)}（显示的是上次的数据）</div>` : '';
    const quotaItems = [...tb.flatMap((s) => trafficItems(s, hist(s.source), cdt.length > 0)), ...cdt.map((s) => cdtItem(s, hist(s.source)))];
    html += section('额度', 'traffic-bot · cdt-guard · 各云的免费额度、账单与熔断', quotaItems.length ? quotaLayout(quotaItems) : '',
      'raw', tb[0] ? ageBadge(tb[0]) : '');
    html += section('优选 IP', 'cfst-ddns · 当前解析的节点与测速', cfst.map((s) => cfstCard(s, hist(s.source))).join(''), 'wide');
    html += section('其他', '未识别的来源', other.map((s) => card(s, esc(s.source), '', `<pre class="tg">${esc(JSON.stringify(s.data, null, 2))}</pre>`)).join(''));
    if (!sources.length) {
      html = `<div class="empty"><h2>还没有任何上报</h2>
        <p>在 traffic-bot、cdt-guard、cfst-ddns 的配置里填上 <code>SONDE_URL</code> 和 <code>SONDE_TOKEN</code>，<br>它们下一次运行后就会出现在这里。</p></div>`;
    }
    main.innerHTML = html;
    layoutTraffic();
    $('#ft-updated').textContent = `更新于 ${fullTime(nowSec())}`;
  }

  // 额度区的列数：Cloudflare 一列，其他来源 k 列。按实际高度选 k，让两边尽量一样高、不留大块空白：
  // 其他来源加起来和 Cloudflare 差不多高 → 1 列（左右各一列）；是它的两倍 → 2 列……；但每列不窄于 290px
  function layoutTraffic() {
    const box = document.querySelector('.tb-layout');
    if (!box) return;
    const stack = box.querySelector('.tb-stack'), mas = box.querySelector('.masonry');
    // 上次挪到左边的卡片先放回右边（窗口大小变了要重新排）
    [...stack.querySelectorAll('[data-moved]')].reverse().forEach((c) => { delete c.dataset.moved; mas.appendChild(c); });
    const apply = (k) => {
      box.style.gridTemplateColumns = `minmax(290px, 1fr) minmax(0, ${k}fr)`;
      mas.style.columnCount = k;
    };
    apply(1);                                                  // 先按 1 列量高度
    if (window.innerWidth <= 760) return;                      // 窄屏：单列，CSS 处理
    const maxCols = Math.max(2, Math.floor((box.clientWidth + 20) / 310));
    const gap = 20;
    const hCf = stack.offsetHeight;
    const hOther = [...mas.children].reduce((a, c) => a + c.offsetHeight + gap, 0);
    const k = Math.max(1, Math.min(maxCols - 1, Math.round(hOther / Math.max(hCf, 1))));
    if (k !== 1) { apply(k); return; }
    // 只有左右两列时：右边明显更高，就把右边最下面的卡片挪到左边最下面，直到再挪会让高的那一列更高为止
    for (let i = 0; i < 6 && mas.children.length > 1; i++) {
      const last = mas.lastElementChild;
      const h = last.offsetHeight + gap;
      const before = Math.max(stack.offsetHeight, mas.offsetHeight);
      const after = Math.max(stack.offsetHeight + h, mas.offsetHeight - h);
      if (after >= before) break;
      last.dataset.moved = '1';
      stack.appendChild(last);
    }
  }
  let resizeTimer = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(layoutTraffic, 150); });

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
  document.addEventListener('click', (e) => { const l = e.target.closest('.line'); if (l) l.classList.toggle('open'); });

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
    if (document.querySelector('.line.open')) return;
    if (Date.now() - state.loadedAt >= STATUS_MS - 1000) load();
  }, 5000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - state.loadedAt > 10_000) load();
  });
})();
