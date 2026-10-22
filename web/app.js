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
  function tgHtml(html) {
    const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
    const walk = (node) => [...node.childNodes].map((n) => {
      if (n.nodeType === Node.TEXT_NODE) return esc(n.textContent);
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

  // 额度行右侧的小曲线（0–100%）
  function spark(pts, color) {
    if (!pts || pts.length < 2) return '<svg class="spark" width="96" height="22" aria-hidden="true"></svg>';
    const x0 = pts[0][0], x1 = pts[pts.length - 1][0];
    return `<svg class="spark" width="96" height="22" viewBox="0 0 96 22" preserveAspectRatio="none" aria-hidden="true">
      <path d="${pathOf(pts, 96, 22, 0, 100, x0, x1)}" style="stroke:${color}"/></svg>`;
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
    return `<div class="bar ${cls}"><i class="l${level(pct)}${p <= 0 ? ' zero' : ''}" style="width:${p}%"></i>${
      marks.map(([at, label]) => `<b class="${at > 80 ? 'end' : ''}" style="left:${clamp(at, 0, 100)}%" data-label="${esc(label)}"></b>`).join('')}</div>`;
  };
  const ageBadge = (src) => (isOffline(src)
    ? `<span class="badge bad" title="最后上报 ${esc(fullTime(src.ts))}，应每 ${Math.round(src.interval / 60)} 分钟一次">离线 · ${esc(ago(src.ts))}</span>`
    : `<span class="badge off" title="${esc(fullTime(src.ts))}">${esc(ago(src.ts))}</span>`);
  const card = (src, title, badges, body, foot = '', { age = true, cls = '' } = {}) => `
    <article class="card ${cls}${isOffline(src) ? ' offline' : ''}">
      <div class="card-head"><h3>${title}</h3>${badges}${age ? ageBadge(src) : ''}</div>
      <div class="card-body">${body}</div>
      ${foot ? `<div class="card-foot">${foot}</div>` : ''}
    </article>`;
  // 一行文字：放不下就省略号，悬停看全文，点一下展开 / 收起（手机上没有悬停）
  const line = (icon, text, cls = '') => `<p class="line ${cls}" title="${esc(text)}">${icon ? `<span class="ic">${icon}</span>` : ''}${esc(text || '–')}</p>`;
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
      .replace(/<blockquote>\s*<\/blockquote>\n?/g, '')
      .replace(/<blockquote>\s+/g, '<blockquote>').replace(/\s+<\/blockquote>/g, '</blockquote>')
      .replace(/^\s+|\s+$/g, '');
    return { sub: tgHtml(sub), body: h ? tgHtml(h) : '' };
  }
  function trafficCards(src, hist, hideAliyun) {
    const providers = (src.data?.providers || [])
      .filter((p) => !p.empty)
      .filter((p) => !(hideAliyun && p.name === 'Aliyun CDT'));
    const html = (p) => {
      const [group, part] = p.group ? [p.group, p.name.split(' · ').slice(1).join(' · ')] : ['', p.name];
      const strip = new RegExp(`^(${[group, part, p.name].filter(Boolean).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*`, 'i');
      // 账号总量在前，单个数据库 / 实例的在后
      const ms = [...(p.metrics || [])].sort((a, b) => (/:d1_db:|:db:/.test(a.key) ? 1 : 0) - (/:d1_db:|:db:/.test(b.key) ? 1 : 0));
      const rows = ms.map((m) => {
        if (m.alert) return m.pct > 0 ? `<div class="alert-row"><span class="badge warn">提醒</span>${esc(m.label)}</div>` : '';
        const lv = level(m.pct);
        return `<div class="metric">
          <span class="metric-label" title="${esc(m.label)}">${esc(m.label.replace(strip, '').replace(strip, '').replace(/^Workers\/Pages\s*/, '') || m.label)}</span>
          <span class="metric-detail num">${esc(m.detail)}</span>
          <span class="metric-pct num${m.pct >= 95 ? ' l5' : m.pct >= 80 ? ' l4' : ''}">${num(m.pct, 1)}%</span>
          <div class="metric-bar">${bar(m.pct)}${spark(hist[m.key], `var(--sig-${lv})`)}</div>
        </div>`;
      }).join('');
      const rep = reportParts(p.html);
      const body = rows + (rep.body ? `<div class="tg">${rep.body}</div>` : '') || '<p class="line muted">–</p>';
      const title = `${group ? `<span class="grp">${esc(group)}</span>` : ''}${esc(part)}${rep.sub ? `<span class="sub">${rep.sub}</span>` : ''}`;
      return card(src, title, p.ok ? '' : '<span class="badge bad">查询失败</span>', body, '', { age: false, cls: 'tb' });
    };
    // 拆开的 Cloudflare 几张卡放在一列里连着排；其他来源在旁边按瀑布流排
    const grouped = providers.filter((p) => p.group).map(html).join('');
    const rest = providers.filter((p) => !p.group).map(html).join('');
    if (!grouped) return `<div class="masonry">${rest}</div>`;
    if (!rest) return `<div class="tb-stack">${grouped}</div>`;
    return `<div class="tb-layout"><div class="tb-stack">${grouped}</div><div class="masonry">${rest}</div></div>`;
  }

  // ---------- cdt-guard ----------
  function cdtCard(src, hist) {
    const d = src.data || {};
    const quota = d.quota_gb || 0, limit = d.limit_gb || 0, used = d.used_gb || 0;
    const guard = d.cost_locked ? ['bad', '费用熔断'] : d.locked ? ['bad', '流量熔断'] : d.hold ? ['warn', '暂停自启'] : ['ok', '守护中'];
    const st = d.status === 'Running' ? 'ok' : d.status === 'Stopped' ? 'warn' : 'ink';
    // CDT 免费额度按北京时间自然月重置
    const cn = new Date(Date.now() + 8 * 3600e3);
    const reset = Date.UTC(cn.getUTCFullYear(), cn.getUTCMonth() + 1, 1) - 8 * 3600e3;
    const daysLeft = Math.max(1, Math.ceil((reset - Date.now()) / 86400e3));
    const toLimit = Math.max(0, limit - used);
    const pct = quota ? (used / quota) * 100 : 0;
    const costPct = d.cost_limit ? ((d.cost || 0) / d.cost_limit) * 100 : 0;
    const regions = Object.entries(d.by_region || {});
    const problem = d.fail ? `最近 ${d.fail} 次查询阿里云失败：${d.last_error || ''}`
      : d.cost_error ? `账单查询失败，费用熔断暂时失效：${d.cost_error}` : '';
    const body = `
      <div class="hero">
        <div class="big"><b class="num">${num(used, 1)}</b><span>/ ${num(quota, 0)} GB<br>${num(pct, 1)}%</span></div>
        ${stats([
          ['距熔断', `<span class="num">${num(toLimit, 1)} GB</span>`],
          ['日均可用', `<span class="num">${num(toLimit / daysLeft, 1)} GB</span>`],
          ['速率', `<span class="num">${num(d.rate_gbh, 2)} GB/h</span>`],
          ['重置', `${daysLeft} 天后`],
        ])}
      </div>
      ${bar(pct, limit && quota ? [[(limit / quota) * 100, `熔断 ${num(limit, 0)}`]] : [], 'bar-lg')}
      ${d.cost_limit ? `<div class="metric">
          <span class="metric-label">本月费用</span>
          <span class="metric-detail num">${num(d.cost, 2)} / ${num(d.cost_limit, 0)} ${esc(d.currency || '')}</span>
          <span class="metric-pct num">${num(costPct, 0)}%</span>
          <div class="metric-bar">${bar(costPct)}${spark(hist.cost && hist.cost.map(([t, v]) => [t, d.cost_limit ? (v / d.cost_limit) * 100 : 0]), `var(--sig-${level(costPct)})`)}</div>
        </div>` : ''}
      ${line(problem ? '⚠️' : '🗺', problem || (regions.length ? regions.map(([r, g]) => `${r} ${num(g, 1)} GB`).join(' · ') : '–'), problem ? 'bad' : 'muted')}
      ${charts2(chart(hist.used_gb, { label: '已用 GB', color: 'var(--accent-blue)', min: 0 }),
                chart(hist.rate_gbh, { label: '速率 GB/h', color: 'var(--accent-purple)', min: 0, digits: 2 }))}`;
    const badges = `<span class="badge ${guard[0]}">${guard[1]}</span><span class="badge ${st}">${esc(d.status || '?')}</span>`;
    const pool = d.cls === 'international' ? '海外 / 香港' : '中国内地';
    return card(src, `🟧 ${esc(d.name || 'Aliyun CDT')}`, badges, body,
      `<span>CDT · ${pool}</span><span>熔断方式：${d.mode === 'sg' ? '安全组封禁' : '关机'}</span>`);
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
        : `<tr class="pad"><td>${i + 1}</td><td>–</td><td></td><td></td><td></td><td></td><td></td></tr>`)).join('')}
      </tbody></table>`;
    const body = hero
      + line(failed ? '⚠️' : '💡', failed ? d.reason : d.why, failed ? 'bad' : '')
      + line('🆚', d.compare, 'muted')
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
    $('#st-last').textContent = sources.length ? ago(Math.max(...sources.map((s) => s.ts))).replace(' 前', '').replace('前', '') : '–';

    let html = state.error ? `<div class="banner">刷新失败：${esc(state.error)}（显示的是上次的数据）</div>` : '';
    html += section('额度', 'traffic-bot · 各云的免费额度与账单', tb.map((s) => trafficCards(s, hist(s.source), cdt.length > 0)).join(''),
      'raw', tb[0] ? ageBadge(tb[0]) : '');
    html += section('阿里云 CDT', 'cdt-guard · 流量熔断与费用熔断', cdt.map((s) => cdtCard(s, hist(s.source))).join(''), 'wide');
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
    if (k !== 1) apply(k);
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
