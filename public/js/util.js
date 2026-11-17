/* global d3 */
// Shared state, formatting, and DOM helpers used by every view.

export const state = {
  snap: null,
  tab: 'overview',
  today: new Date(),
  themes: [],
  themeById: {},
  filters: { status: 'actionable', agency: 'all', setAside: 'any', themes: new Set(), relevant: true, saved: false, tracked: false, pursuit: null, q: '' },
  tracking: { q: '', org: 'all', active: false, priority: false },
  sort: { key: 'dueDate', dir: 1 },
  agencyKey: null,
  marketTheme: null,
  grantsTitleOnly: true,
  refreshing: false,
  research: { enabled: false, model: '', items: [], selectedId: null, current: null },
};

// Cross-module calls (switching tabs, opening drawers, starting research) are registered here by
// main.js so views do not have to import each other.
export const actions = {};

export const OTHER = { id: 'other', label: 'Other', color: 'var(--other)' };

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- Formatting ----------
const si = d3.format('.3~s');
export const money = (v) => (v == null || !isFinite(v) ? '—' : `$${si(v).replace('G', 'B').replace('k', 'K')}`);
export const int = d3.format(',');
export const pct = d3.format('.0%');
export const signedPct = (v) => `${v >= 0 ? '+' : ''}${pct(v)}`;
export const parseDate = (s) => (s ? new Date(`${s.slice(0, 10)}T00:00:00Z`) : null);
export const fmtDate = d3.utcFormat('%b %-d, %Y');
export const fmtShort = d3.utcFormat('%b %-d');
export const fmtMonthYr = d3.utcFormat('%b %Y');
export const fmtStamp = d3.timeFormat('%b %-d, %-I:%M %p');
export const daysUntil = (s) => Math.round((parseDate(s) - state.today) / 864e5);
export const truncate = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');
export const fy = (n) => `FY${String(n).slice(-2)}`;

export const themeColor = (id) => (state.themeById[id] || OTHER).color;
export const themeLabel = (id) => (state.themeById[id] || OTHER).label;

const ACRONYMS =
  /\b(Llc|Usg|It|Us|Dhs|Cisa|Caci|Cgi|Ecs|Saic|Gdit|Ibm|Ai|Ii|Iii|Iv|Jv|Lp|Cdm|Soc|Hq|Dod|Disa|Fbi|Va|Hhs|Nasa|Cms|Gsa|Fema|Tsa|Cbp|Ice|Bpa|Idiq|Saas|Bd|Mitre|Sra|Nci|Bae|Hii|Kbr|Pae|At&t)\b/g;
export const titleCase = (s) =>
  (s || '')
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/'S\b/g, "'s")
    .replace(ACRONYMS, (m) => m.toUpperCase())
    .replace(/,? Inc\b\.?/g, ' Inc')
    .replace(/ - Federal$/, '');

// Award descriptions run to paragraphs; the first sentence is nearly always the name of the work.
export const shortDesc = (s, n = 90) => truncate(titleCase((s || '').split(/\.\s|;|\n/)[0].replace(/\.$/, '')), n);

const SET_ASIDES = {
  SBA: 'Total small business',
  SBP: 'Partial small business',
  '8A': '8(a)',
  '8AN': '8(a) sole source',
  WOSB: 'WOSB',
  EDWOSB: 'EDWOSB',
  HZC: 'HUBZone',
  SDVOSBC: 'SDVOSB',
  VSA: 'Veteran-owned',
};
export const setAsideLabel = (s) => (s ? SET_ASIDES[s] || s : 'None stated');

export const isActionable = (o) => o.status === 'open' || o.status === 'forecast';

export function noticeType(o) {
  if (o.status === 'forecast') return o.type === 'Recompete' ? 'Forecast (recompete)' : 'Forecast';
  const t = o.type;
  if (!t) return 'Notice';
  if (/solicitation/i.test(t) && !/pre/i.test(t)) return 'Solicitation';
  if (/award/i.test(t)) return 'Award notice';
  return t;
}

// ---------- DOM builder (text only; data is never injected as HTML) ----------
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'href') {
      if (/^(https?:\/\/|mailto:|tel:)/i.test(v)) {
        el.setAttribute('href', v);
        if (/^http/i.test(v)) {
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
        }
      }
    } else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const tag = (id) => h('span', { class: 'tag', style: `--c:${themeColor(id)}` }, themeLabel(id));
export const tags = (ids) => (ids && ids.length ? ids.map(tag) : h('span', { class: 'muted' }, '—'));

export function duePill(o) {
  if (!o.dueDate) return h('span', { class: 'muted' }, '—');
  const d = daysUntil(o.dueDate);
  if (o.status === 'forecast') {
    return d < 0
      ? h('span', { class: 'pill', title: 'The anticipated date has passed, so release could come at any time' }, `Overdue · ${fmtMonthYr(parseDate(o.dueDate))}`)
      : h('span', { class: 'pill info' }, fmtMonthYr(parseDate(o.dueDate)));
  }
  if (d < 0) return h('span', { class: 'muted nowrap' }, fmtShort(parseDate(o.dueDate)));
  const cls = d <= 7 ? 'urgent' : d <= 21 ? 'soon' : 'ok';
  return h('span', { class: `pill ${cls}` }, d === 0 ? 'Today' : `${fmtShort(parseDate(o.dueDate))} · ${d}d`);
}

export function endPill(date) {
  if (!date) return h('span', { class: 'muted' }, '—');
  const d = daysUntil(date);
  const cls = d < 0 ? '' : d <= 180 ? 'urgent' : d <= 365 ? 'soon' : '';
  return h('span', { class: `pill ${cls}` }, fmtMonthYr(parseDate(date)));
}

export function stats(el, items) {
  el.replaceChildren(
    ...items.map((k) =>
      h('div', { class: 'stat' }, h('div', { class: 'label' }, k.label), h('div', { class: 'value' }, k.value), h('div', { class: 'sub', title: k.sub || null }, k.sub || '\u00a0'))
    )
  );
}

export function facts(pairs) {
  return h(
    'dl',
    { class: 'facts' },
    pairs.filter(([, v]) => v != null && v !== '').map(([k, v]) => h('div', null, h('dt', null, k), h('dd', null, v)))
  );
}

export function emptyRow(colspan, text) {
  return h('tr', null, h('td', { colspan, class: 'empty' }, text));
}

// ---------- Tooltip ----------
const tipEl = $('#tooltip');
export const tip = {
  show(event, title, rows = []) {
    tipEl.replaceChildren(
      h('div', { class: 'tt-title' }, title),
      ...rows.filter(Boolean).map(([k, v]) => h('div', { class: 'tt-row' }, h('span', null, k), h('b', null, v)))
    );
    tipEl.classList.add('show');
    const pad = 14;
    const r = tipEl.getBoundingClientRect();
    let x = event.clientX + pad;
    let y = event.clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = event.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = event.clientY - r.height - pad;
    tipEl.style.left = `${Math.max(8, x)}px`;
    tipEl.style.top = `${Math.max(8, y)}px`;
  },
  hide() {
    tipEl.classList.remove('show');
  },
};

// ---------- Drawer ----------
const drawer = $('#drawer');
export function openDrawer(content) {
  $('#drawer-body').replaceChildren(content);
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  $('.drawer-panel').scrollTop = 0;
}
export function closeDrawer() {
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
}
drawer.addEventListener('click', (e) => e.target.closest('[data-close]') && closeDrawer());
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeDrawer());

// ---------- Server calls ----------
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- Minimal Markdown (paragraphs, lists, bold, italics, code, links) ----------
function inline(text) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|\*([^*\n]+)\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(h('strong', null, m[1]));
    else if (m[2]) out.push(h('em', null, m[2]));
    else if (m[3]) out.push(h('code', null, m[3]));
    else if (m[4]) out.push(h('a', { href: m[5] }, m[4]));
    else out.push(h('a', { href: m[6] }, hostOf(m[6])));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function markdown(src) {
  const root = h('div', { class: 'md' });
  let list = null;
  let para = [];
  const flush = () => {
    if (para.length) root.append(h('p', null, inline(para.join(' '))));
    para = [];
  };
  for (const raw of String(src || '').split('\n')) {
    const line = raw.trim();
    const bullet = line.match(/^([-*•]|\d+[.)])\s+(.*)$/);
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (bullet) {
      flush();
      const ordered = /\d/.test(bullet[1]);
      if (!list || (list.tagName === 'OL') !== ordered) {
        list = h(ordered ? 'ol' : 'ul');
        root.append(list);
      }
      list.append(h('li', null, inline(bullet[2])));
      continue;
    }
    list = null;
    if (!line) flush();
    else if (heading) {
      flush();
      root.append(h('p', null, h('strong', null, heading[1])));
    } else para.push(line);
  }
  flush();
  return root;
}
