/* global d3 */
import {
  state,
  actions,
  $,
  $$,
  h,
  money,
  int,
  pct,
  signedPct,
  parseDate,
  fmtDate,
  fmtShort,
  daysUntil,
  truncate,
  titleCase,
  shortDesc,
  fy,
  themeLabel,
  tags,
  duePill,
  endPill,
  stats,
  emptyRow,
  setAsideLabel,
  isActionable,
  noticeType,
} from './util.js';
import { hbar, fyBars, weeklyFlow, trendLines, timeline, legend, empty, BLUE, GREY } from './charts.js';

const windowTotal = (profile, startFy) => d3.sum((profile?.overTime || []).filter((r) => r.fy >= startFy), (r) => r.amount);
const allContracts = () => state.snap.agencies.flatMap((a) => a.contracts);
const lanes = () => {
  const order = state.snap.config.agencies.map((a) => a.label);
  return [...new Set(state.snap.opportunities.map((o) => o.lane))].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || d3.ascending(a, b);
  });
};

export const pursuitName = (id) => state.snap.pursuits.find((p) => p.id === id)?.name || id;

function rowList(el, items, render, emptyText) {
  el.replaceChildren(...(items.length ? items.map(render) : [h('li', { class: 'empty-row' }, emptyText)]));
}

// ---------- Overview ----------
export function renderOverview() {
  const s = state.snap;
  const rel = s.opportunities.filter((o) => o.relevant);
  const open = rel.filter((o) => o.status === 'open');
  const forecasts = rel.filter((o) => o.status === 'forecast');
  const actionable = [...open, ...forecasts];
  const valued = actionable.filter((o) => o.value);
  const due7 = open.filter((o) => o.dueDate && daysUntil(o.dueDate) <= 7 && daysUntil(o.dueDate) >= 0).length;
  const overdue = forecasts.filter((o) => o.dueDate && daysUntil(o.dueDate) < 0).length;
  const week = rel.filter((o) => o.postedDate && daysUntil(o.postedDate) >= -7).length;
  const priorWeek = rel.filter((o) => o.postedDate && daysUntil(o.postedDate) < -7 && daysUntil(o.postedDate) >= -14).length;
  const saved = s.opportunities.filter((o) => o.saved).length;

  stats($('#stats-overview'), [
    { label: 'Open solicitations', value: int(open.length), sub: due7 ? `${due7} due within 7 days` : 'None due this week' },
    { label: 'Forecasts', value: int(forecasts.length), sub: overdue ? `${overdue} past their anticipated date` : 'All still ahead' },
    { label: 'Posted this week', value: int(week), sub: `${priorWeek} the week before` },
    { label: 'Disclosed pipeline value', value: money(d3.sum(valued, (o) => o.value)), sub: `Stated on ${valued.length} of ${actionable.length} notices` },
    { label: 'Saved', value: int(saved), sub: saved ? 'Starred opportunities' : 'Star a notice to track it' },
  ]);

  const oppRow = (o) =>
    h(
      'li',
      { onclick: () => actions.showOpportunity(o) },
      h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, o.title), h('div', { class: 'row-sub' }, [o.lane, noticeType(o), ...o.themes.map(themeLabel)].join(' · '))),
      h('div', { class: 'row-end' }, duePill(o), o.value ? h('div', null, money(o.value)) : null)
    );
  rowList(
    $('#list-due'),
    open.filter((o) => o.dueDate && daysUntil(o.dueDate) >= 0).sort((a, b) => d3.ascending(a.dueDate, b.dueDate)).slice(0, 7),
    oppRow,
    'Nothing open in your focus areas right now.'
  );
  const upcoming = forecasts.filter((o) => o.dueDate && daysUntil(o.dueDate) >= 0).sort((a, b) => d3.ascending(a.dueDate, b.dueDate));
  const late = forecasts.filter((o) => o.dueDate && daysUntil(o.dueDate) < 0).sort((a, b) => d3.descending(a.dueDate, b.dueDate));
  rowList($('#list-forecast'), [...upcoming, ...late].slice(0, 7), oppRow, 'No forecasts in your focus areas.');

  legend($('#legend-flow'), [...state.themes, { label: 'Outside focus areas', color: 'var(--other)' }]);
  weeklyFlow($('#chart-flow'), s.opportunities);
  renderMatrix(rel);

  const horizon = d3.utcMonth.offset(state.today, 18);
  rowList(
    $('#list-recompete'),
    allContracts()
      .filter((c) => c.active && c.potentialEndDate && parseDate(c.potentialEndDate) <= horizon)
      .sort((a, b) => (b.potentialValue || 0) - (a.potentialValue || 0))
      .slice(0, 7),
    (c) =>
      h(
        'li',
        { onclick: () => actions.showContract(c) },
        h(
          'div',
          { class: 'row-main' },
          h('div', { class: 'row-title' }, `${c.awardeeParent || c.awardee} · ${shortDesc(c.description)}`),
          h('div', { class: 'row-sub' }, [c.agencyLabel, c.vehicle, ...(c.themes || []).map(themeLabel)].filter(Boolean).join(' · '))
        ),
        h('div', { class: 'row-end' }, endPill(c.potentialEndDate), h('div', null, money(c.potentialValue)))
      ),
    'No tracked contracts end in the next 18 months.'
  );
}

function renderMatrix(rel) {
  // With many watched agencies, show the ten with the most relevant notices.
  const rows = lanes()
    .map((lane) => ({ lane, n: rel.filter((o) => o.lane === lane).length }))
    .filter((r) => r.n)
    .sort((a, b) => b.n - a.n)
    .slice(0, 10)
    .map((r) => r.lane);
  if (!rows.length) return empty($('#matrix'), 'No relevant notices in the look-back window');
  const count = (lane, theme) => rel.filter((o) => o.lane === lane && o.themes.includes(theme)).length;
  const max = d3.max(rows.flatMap((lane) => state.themes.map((t) => count(lane, t.id)))) || 1;
  $('#matrix').replaceChildren(
    h(
      'table',
      { class: 'matrix' },
      h('thead', null, h('tr', null, h('th'), state.themes.map((t) => h('th', null, t.label)))),
      h(
        'tbody',
        null,
        rows.map((lane) =>
          h(
            'tr',
            null,
            h('th', null, lane),
            state.themes.map((t) => {
              const n = count(lane, t.id);
              const share = Math.round(12 + 78 * Math.sqrt(n / max));
              return h(
                'td',
                null,
                h(
                  'button',
                  {
                    type: 'button',
                    class: n ? null : 'zero',
                    disabled: !n,
                    style: n ? `background:color-mix(in srgb, ${t.color} ${share}%, var(--surface));color:${share > 55 ? '#fff' : 'inherit'}` : null,
                    onclick: () => {
                      Object.assign(state.filters, { themes: new Set([t.id]), agency: `lane:${lane}`, status: 'all', relevant: true, saved: false, tracked: false, pursuit: null, q: '' });
                      actions.switchTab('opportunities');
                    },
                  },
                  n || '·'
                )
              );
            })
          )
        )
      )
    )
  );
}

// ---------- Opportunities ----------
export function buildControls() {
  const s = state.snap;
  const mentioned = [...new Set(s.opportunities.flatMap((o) => o.mentions))];
  $('#filter-agency').replaceChildren(
    h('option', { value: 'all' }, 'All agencies'),
    ...lanes().map((l) => h('option', { value: `lane:${l}` }, l)),
    ...mentioned.map((l) => h('option', { value: `about:${l}` }, `${l} + mentions by other offices`)),
    s.config.savedSearches.length ? h('option', { value: 'search' }, 'From saved searches') : null
  );
  $('#filter-themes').replaceChildren(
    ...state.themes.map((t) => h('button', { class: 'chip', 'data-theme': t.id, style: `--c:${t.color}`, type: 'button' }, h('i'), t.label))
  );
  $('#market-theme').replaceChildren(...state.themes.map((t) => h('button', { 'data-v': t.id, type: 'button' }, t.label)));
  $('#agency-picker').replaceChildren(...s.agencies.map((a) => h('button', { 'data-v': a.key, type: 'button', title: a.name }, a.label)));
  if (!state.themeById[state.marketTheme]) state.marketTheme = state.themes[0]?.id;
  if (!s.agencies.some((a) => a.key === state.agencyKey)) state.agencyKey = s.agencies[0]?.key;
}

const SMALL_BIZ = /^(SBA|SBP|8A|8AN|WOSB|EDWOSB|HZC|HZS|SDVOSBC|SDVOSBS|VSA|VSS)/;

function filteredOpps() {
  const f = state.filters;
  const terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  return state.snap.opportunities.filter((o) => {
    if (f.saved && !o.saved) return false;
    if (f.tracked && !o.pursuits.length) return false;
    if (f.pursuit && !o.pursuits.includes(f.pursuit)) return false;
    if (f.relevant && !o.relevant) return false;
    if (f.status === 'actionable' && !isActionable(o)) return false;
    if ((f.status === 'open' || f.status === 'forecast') && o.status !== f.status) return false;
    if (f.agency === 'search' && !o.viaSearch) return false;
    if (f.agency.startsWith('lane:') && o.lane !== f.agency.slice(5)) return false;
    if (f.agency.startsWith('about:') && o.lane !== f.agency.slice(6) && !o.mentions.includes(f.agency.slice(6))) return false;
    if (f.setAside === 'small' && !SMALL_BIZ.test(o.setAside || '')) return false;
    if (f.setAside === 'none' && o.setAside) return false;
    if (f.themes.size && !o.themes.some((t) => f.themes.has(t))) return false;
    return terms.every((t) => o._hay.includes(t));
  });
}

// Soonest first means upcoming dates in order, then dates already passed (most recent first),
// so slipped forecasts do not bury what is actually due next.
function dueOrder(a, b) {
  const pa = a.dueDate < state.snap.asOf;
  const pb = b.dueDate < state.snap.asOf;
  if (pa !== pb) return pa ? 1 : -1;
  return (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0) * (pa ? -1 : 1);
}

function sortOpps(list) {
  const { key, dir } = state.sort;
  const val = (o) => (key === 'title' ? o.title.toLowerCase() : key === 'type' ? noticeType(o) : o[key]);
  return list.sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (key === 'dueDate' && dir === 1) return dueOrder(a, b);
    return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
  });
}

export function starButton(o, onChange) {
  const btn = h('button', { class: `star${o.saved ? ' on' : ''}`, type: 'button', title: o.saved ? 'Remove from saved' : 'Save', 'aria-label': 'Save' }, o.saved ? '★' : '☆');
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await actions.toggleSaved(o);
    if (onChange) onChange();
  });
  return btn;
}

export function renderOpportunities() {
  const f = state.filters;
  $$('#filter-status button').forEach((b) => b.classList.toggle('active', b.dataset.v === f.status));
  $('#filter-agency').value = f.agency;
  if ($('#filter-agency').value !== f.agency) f.agency = $('#filter-agency').value = 'all';
  $('#filter-setaside').value = f.setAside;
  $$('#filter-themes .chip').forEach((c) => c.classList.toggle('active', f.themes.has(c.dataset.theme)));
  $('#filter-relevant').checked = f.relevant;
  $('#filter-saved').checked = f.saved;
  $('#filter-tracked').checked = f.tracked;
  if ($('#search').value.trim() !== f.q) $('#search').value = f.q;

  const list = sortOpps(filteredOpps());
  $$('#opp-table th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === state.sort.key);
    th.classList.toggle('asc', th.dataset.sort === state.sort.key && state.sort.dir === 1);
  });
  const total = d3.sum(list, (o) => o.value || 0);
  $('#results-meta').textContent = `${int(list.length)} of ${int(state.snap.opportunities.length)} notices${total ? ` · ${money(total)} disclosed value` : ''}${
    list.length > 300 ? ' · showing the first 300' : ''
  }`;
  const tbody = $('#opp-table tbody');
  if (!list.length) return tbody.replaceChildren(emptyRow(8, 'No notices match these filters.'));
  tbody.replaceChildren(
    ...list.slice(0, 300).map((o) =>
      h(
        'tr',
        { onclick: () => actions.showOpportunity(o) },
        h('td', { class: 'star-col' }, starButton(o, renderOpportunities)),
        h(
          'td',
          null,
          h('div', { class: 'cell-title' }, o.title),
          h('div', { class: 'cell-sub' }, [o.agency?.name || o.lane, o.mentions.length ? `mentions ${o.mentions.join(', ')}` : null, o.sourceId?.replace(/^\*/, '')].filter(Boolean).join(' · '))
        ),
        h('td', { class: 'nowrap muted' }, noticeType(o), o.setAside ? h('div', { class: 'cell-sub' }, setAsideLabel(o.setAside)) : null),
        h('td', null, tags(o.themes), o.pursuits.map((id) => h('span', { class: 'tag tracked' }, pursuitName(id)))),
        h('td', { class: 'num muted' }, o.fit),
        h('td', { class: 'nowrap muted' }, o.postedDate ? fmtShort(parseDate(o.postedDate)) : '—'),
        h('td', null, duePill(o)),
        h('td', { class: 'num' }, money(o.value))
      )
    )
  );
}

export function exportCsv() {
  const rows = sortOpps(filteredOpps());
  const cols = [
    ['Title', (o) => o.title],
    ['Agency', (o) => o.agency?.name],
    ['Watched as', (o) => o.lane],
    ['Status', (o) => o.status],
    ['Notice type', (o) => o.type],
    ['Focus areas', (o) => o.themes.map(themeLabel).join('; ')],
    ['Tracking list', (o) => o.pursuits.map(pursuitName).join('; ')],
    ['Fit', (o) => o.fit],
    ['Posted', (o) => o.postedDate],
    ['Due / expected', (o) => o.dueDate],
    ['Est. value (high)', (o) => o.valueHigh],
    ['Est. value (low)', (o) => o.valueLow],
    ['Set-aside', (o) => (o.setAside ? setAsideLabel(o.setAside) : '')],
    ['NAICS', (o) => o.naics],
    ['PSC', (o) => o.psc],
    ['Source ID', (o) => o.sourceId],
    ['Contact', (o) => o.contacts?.[0]?.name],
    ['Contact email', (o) => o.contacts?.[0]?.email],
    ['Saved', (o) => (o.saved ? 'yes' : '')],
    ['HigherGov URL', (o) => o.url],
    ['Source URL', (o) => o.sourceUrl],
  ];
  const esc = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.map((c) => c[0]).join(','), ...rows.map((o) => cols.map(([, fn]) => esc(fn(o))).join(','))].join('\n');
  const a = h('a', { download: `opportunities-${state.snap.asOf}.csv` });
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- Tracking list ----------
const CONFIDENCE_NOTE = {
  none: 'No public description found',
  low: 'Thin public information; treat the scope as a lead, not a fact',
};

export function renderTracking() {
  const all = state.snap.pursuits;
  const f = state.tracking;
  const orgs = [...new Set(all.map((p) => p.org))];
  const select = $('#tracking-org');
  if (select.options.length !== orgs.length + 1) {
    select.replaceChildren(h('option', { value: 'all' }, 'All organisations'), ...orgs.map((o) => h('option', { value: o }, `${o} (${all.filter((p) => p.org === o).length})`)));
  }
  select.value = f.org;
  $('#tracking-active').checked = f.active;
  $('#tracking-priority').checked = f.priority;

  const terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = (p) => [p.name, p.fullName, p.agency, p.scope, p.notes, p.incumbents.join(' '), p.followUps.join(' '), p.keywords.join(' '), p.timing].join(' ').toLowerCase();
  const list = all.filter(
    (p) =>
      (f.org === 'all' || p.org === f.org) &&
      (!f.active || p.notices.length || p.awards.length) &&
      (!f.priority || p.priority === 'high') &&
      terms.every((t) => hay(p).includes(t))
  );
  const withNotices = all.filter((p) => p.notices.length).length;
  const withAwards = all.filter((p) => p.awards.length).length;
  const described = all.filter((p) => p.scope).length;
  $('#tracking-meta').textContent = `${all.length} efforts · ${described} with a public scope description · ${withNotices} with notices in the database · ${withAwards} with an incumbent contract on USAspending`;

  const tbody = $('#tracking-table tbody');
  if (!list.length) return tbody.replaceChildren(emptyRow(5, 'No efforts match these filters.'));
  tbody.replaceChildren(
    ...list.map((p) =>
      h(
        'tr',
        { onclick: () => actions.showPursuit(p) },
        h(
          'td',
          null,
          h('div', { class: 'cell-title' }, p.name, p.priority === 'high' ? h('span', { class: 'pill urgent', style: 'margin-left:8px' }, 'High') : null),
          h('div', { class: 'cell-sub' }, [p.agency, p.fullName && p.fullName !== p.name ? truncate(p.fullName, 70) : null].filter(Boolean).join(' · '))
        ),
        h(
          'td',
          { class: 'scope-col' },
          p.scope ? h('div', { class: 'clamp' }, p.scope) : h('span', { class: 'muted' }, CONFIDENCE_NOTE.none),
          p.topics.length ? h('div', { style: 'margin-top:4px' }, tags(p.topics)) : null
        ),
        h(
          'td',
          null,
          p.incumbents.length ? h('div', null, truncate(p.incumbents.join(', '), 70)) : null,
          p.notes ? h('div', { class: 'cell-sub' }, truncate(p.notes, 90)) : null,
          !p.incumbents.length && !p.notes ? h('span', { class: 'muted' }, '—') : null
        ),
        h('td', { class: 'muted' }, p.timing ? truncate(p.timing, 60) : '—', p.value ? h('div', { class: 'cell-sub' }, truncate(p.value, 40)) : null),
        h(
          'td',
          { class: 'nowrap' },
          p.notices.length ? h('span', { class: 'pill info' }, `${p.notices.length} notice${p.notices.length > 1 ? 's' : ''}`) : null,
          p.notices.length && p.awards.length ? ' ' : null,
          p.awards.length ? h('span', { class: 'pill ok' }, `${p.awards.length} award${p.awards.length > 1 ? 's' : ''}`) : null,
          !p.notices.length && !p.awards.length ? h('span', { class: 'muted' }, '—') : null
        )
      )
    )
  );
}

// ---------- Agencies ----------
export function renderAgencies() {
  const s = state.snap;
  const agency = s.agencies.find((a) => a.key === state.agencyKey);
  if (!agency) return;
  $$('#agency-picker button').forEach((b) => b.classList.toggle('active', Number(b.dataset.v) === agency.key));
  $('#agency-title').textContent = agency.name;
  const notices = s.opportunities.filter((o) => o.relevant && isActionable(o) && (o.lane === agency.label || o.mentions.includes(agency.label)));
  $('#agency-sub').replaceChildren(
    agency.role === 'funding' ? 'Dollars this agency funds, whichever office signs the contract. ' : 'Contracts this office awards. ',
    notices.length
      ? h(
          'a',
          {
            href: '#opportunities',
            onclick: (e) => {
              e.preventDefault();
              const mentioned = s.opportunities.some((o) => o.mentions.includes(agency.label));
              Object.assign(state.filters, { agency: `${mentioned ? 'about' : 'lane'}:${agency.label}`, status: 'actionable', relevant: true, saved: false, tracked: false, pursuit: null, themes: new Set(), q: '' });
              actions.switchTab('opportunities');
            },
          },
          `${notices.length} open or forecast notice${notices.length > 1 ? 's' : ''} in your focus areas`
        )
      : 'No open or forecast notices in your focus areas right now.'
  );
  const p = agency.profile;
  const contracts = [...agency.contracts].sort((a, b) => (b.potentialValue || 0) - (a.potentialValue || 0));
  const active = contracts.filter((c) => c.active);
  const horizon = d3.utcMonth.offset(state.today, 18);
  const expiring = active.filter((c) => c.potentialEndDate && parseDate(c.potentialEndDate) <= horizon);
  const total = windowTotal(p, s.market.startFy);
  const top5 = d3.sum((p?.recipients || []).slice(0, 5), (r) => r.amount);
  const full = (p?.overTime || []).filter((r) => r.fy < s.market.currentFy);
  const last = full[full.length - 1];
  const prev = full[full.length - 2];

  $$('.window-label').forEach((e) => (e.textContent = s.market.window.label));
  stats($('#stats-agency'), [
    { label: `Obligations, ${s.market.window.label}`, value: p ? money(total) : '—', sub: last && prev?.amount ? `${fy(last.fy)} ${money(last.amount)}, ${signedPct(last.amount / prev.amount - 1)} on ${fy(prev.fy)}` : '' },
    { label: 'Share held by top 5 vendors', value: total ? pct(top5 / total) : '—', sub: p?.recipients?.[0] ? `Led by ${titleCase(p.recipients[0].name)}` : '' },
    { label: 'Active tracked contracts', value: int(active.length), sub: `${money(d3.sum(active, (c) => c.potentialValue || 0))} potential value` },
    { label: 'Ending within 18 months', value: int(expiring.length), sub: `${money(d3.sum(expiring, (c) => c.potentialValue || 0))} potential value` },
  ]);

  fyBars($('#chart-agency-fy'), p?.overTime || [], s.market.currentFy);
  hbar($('#chart-agency-vendors'), (p?.recipients || []).map((d) => ({ label: titleCase(d.name), value: d.amount })), {
    max: 12,
    tooltip: (d) => [['Obligated', money(d.value)], [`Share of ${agency.label}`, total ? pct(d.value / total) : '—']],
    onClick: (d) => actions.researchCompany(d.label),
  });
  hbar($('#chart-agency-psc'), (p?.psc || []).map((d) => ({ label: `${d.code} ${titleCase(d.name)}`, value: d.amount })), { max: 10, color: () => GREY });

  if (agency.role === 'funding' && p?.agencies?.length) {
    $('#agency-third-title').textContent = 'Who awards its work';
    $('#agency-third-hint').textContent = `Contracting offices spending ${agency.label} dollars, ${s.market.window.label}`;
    hbar($('#chart-agency-third'), p.agencies.map((d) => ({ label: d.name, value: d.amount })), { max: 10, color: () => GREY });
  } else {
    $('#agency-third-title').textContent = 'Contract vehicles';
    $('#agency-third-hint').textContent = 'Potential value of the tracked contracts, by vehicle';
    const vehicles = d3
      .rollups(contracts, (v) => ({ value: d3.sum(v, (c) => c.potentialValue || 0), n: v.length }), (c) => c.vehicle || 'No vehicle (standalone)')
      .map(([label, d]) => ({ label, ...d }))
      .sort((a, b) => b.value - a.value);
    hbar($('#chart-agency-third'), vehicles, { max: 10, color: () => GREY, tooltip: (d) => [['Potential value', money(d.value)], ['Contracts', int(d.n)]] });
  }

  timeline($('#chart-agency-timeline'), contracts, actions.showContract);

  $('#agency-contracts-hint').textContent = contracts.length
    ? `${contracts.length} largest by potential value (HigherGov, pulled ${fmtShort(parseDate(agency.contractsFetchedOn))})`
    : '';
  $('#agency-contracts tbody').replaceChildren(
    ...(contracts.length
      ? contracts.slice(0, 50).map((c) =>
          h(
            'tr',
            { onclick: () => actions.showContract(c) },
            h('td', null, h('div', { class: 'cell-title' }, shortDesc(c.description, 110) || c.awardId), h('div', { class: 'cell-sub' }, c.awardId)),
            h('td', null, c.awardeeParent || c.awardee || '—'),
            h('td', null, tags(c.themes)),
            h('td', { class: 'muted' }, c.vehicle || '—'),
            h('td', null, c.active ? endPill(c.potentialEndDate || c.currentEndDate) : h('span', { class: 'muted' }, 'Ended')),
            h('td', { class: 'num' }, money(c.potentialValue))
          )
        )
      : [emptyRow(6, 'No contracts stored for this agency yet. Press Refresh data.')])
  );
}

// ---------- Market ----------
function unionAwards() {
  const byId = new Map();
  for (const t of state.themes) {
    for (const a of state.snap.market.profiles[t.id]?.topAwards || []) {
      const existing = byId.get(a.awardId);
      if (existing) existing.themes.push(t.id);
      else byId.set(a.awardId, { ...a, themes: [t.id] });
    }
  }
  return [...byId.values()];
}

export function renderMarket() {
  const M = state.snap.market;
  $$('.window-label').forEach((e) => (e.textContent = M.window.label));
  stats(
    $('#stats-market'),
    state.themes.map((t) => {
      const p = M.profiles[t.id];
      if (!p) return { label: t.label, value: '—', sub: 'No data yet' };
      const total = windowTotal(p, M.startFy);
      const a = p.overTime.find((r) => r.fy === M.currentFy - 2);
      const b = p.overTime.find((r) => r.fy === M.currentFy - 1);
      return {
        label: `${t.label}, ${M.window.label}`,
        value: money(total),
        sub: a?.amount && b ? `${fy(b.fy)} ${signedPct(b.amount / a.amount - 1)} on ${fy(a.fy)}` : '',
      };
    })
  );

  const series = state.themes.map((t) => ({ label: t.label, color: t.color, values: (M.profiles[t.id]?.overTime || []).filter((v) => v.fy < M.currentFy) }));
  legend($('#legend-trend'), state.themes);
  trendLines($('#chart-trend'), series);

  $$('#market-theme button').forEach((b) => b.classList.toggle('active', b.dataset.v === state.marketTheme));
  const p = M.profiles[state.marketTheme];
  const t = state.themeById[state.marketTheme];
  const total = windowTotal(p, M.startFy);
  hbar($('#chart-market-agencies'), (p?.agencies || []).map((d) => ({ label: d.name, value: d.amount })), { color: () => t.color });
  hbar($('#chart-market-vendors'), (p?.recipients || []).map((d) => ({ label: titleCase(d.name), value: d.amount })), {
    color: () => t.color,
    format: (v) => `${money(v)} · ${total ? pct(v / total) : ''}`,
    tooltip: (d) => [['Obligated', money(d.value)], [`Share of ${t.label}`, total ? pct(d.value / total) : '—']],
    onClick: (d) => actions.researchCompany(d.label),
  });

  const horizon = d3.utcMonth.offset(state.today, 18);
  const expiring = unionAwards()
    .filter((a) => a.endDate && parseDate(a.endDate) >= state.today && parseDate(a.endDate) <= horizon)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 30);
  $('#expiring-table tbody').replaceChildren(
    ...(expiring.length
      ? expiring.map((a) =>
          h(
            'tr',
            { onclick: () => actions.showAward(a) },
            h('td', null, h('div', { class: 'cell-title' }, shortDesc(a.description, 100) || a.awardId), h('div', { class: 'cell-sub' }, a.awardId)),
            h('td', null, titleCase(a.recipient)),
            h('td', { class: 'muted' }, a.subAgency),
            h('td', null, tags(a.themes)),
            h('td', null, endPill(a.endDate)),
            h('td', { class: 'num' }, money(a.amount))
          )
        )
      : [emptyRow(6, 'No large awards end in the next 18 months.')])
  );
}

// ---------- Grants ----------
export function renderGrants() {
  const all = state.snap.grants || [];
  const list = state.grantsTitleOnly ? all.filter((g) => g.titleMatch) : all;
  const posted = list.filter((g) => g.status === 'posted');
  const closing = list.filter((g) => g.closingSoon).sort((a, b) => d3.ascending(a.closeDate, b.closeDate));
  $('#grants-meta').textContent = `${int(list.length)} grant programs on Grants.gov${state.grantsTitleOnly ? `, out of ${int(all.length)} keyword matches` : ''}.`;
  stats($('#stats-grants'), [
    { label: 'Open now', value: int(posted.length), sub: 'Accepting applications' },
    { label: 'Forecasted', value: int(list.length - posted.length), sub: 'Announced, not yet open' },
    { label: 'Closing within 30 days', value: int(closing.length), sub: closing[0] ? truncate(closing[0].title, 46) : 'None' },
    { label: 'Agencies', value: int(new Set(list.map((g) => g.agencyCode)).size), sub: 'With a matching program' },
  ]);
  hbar(
    $('#chart-grant-agencies'),
    d3
      .rollups(list, (v) => v.length, (g) => g.agency)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value),
    { format: (v) => `${v}`, max: 10, color: () => BLUE }
  );
  const sorted = [...list].sort((a, b) => d3.ascending(a.closeDate || '9999', b.closeDate || '9999'));
  $('#grants-table tbody').replaceChildren(
    ...(sorted.length
      ? sorted.slice(0, 300).map((g) =>
          h(
            'tr',
            { onclick: () => window.open(g.url, '_blank', 'noopener') },
            h('td', null, h('div', { class: 'cell-title' }, g.title), h('div', { class: 'cell-sub' }, [g.number, g.cfda ? `ALN ${g.cfda}` : null].filter(Boolean).join(' · '))),
            h('td', { class: 'muted' }, g.agency),
            h('td', null, tags(g.themes)),
            h('td', null, h('span', { class: `pill ${g.status === 'posted' ? 'ok' : 'info'}` }, g.status === 'posted' ? 'Open' : 'Forecast')),
            h('td', { class: 'nowrap muted' }, g.openDate ? fmtShort(parseDate(g.openDate)) : '—'),
            h('td', { class: 'nowrap' }, g.closeDate ? h('span', { class: g.closingSoon ? 'pill urgent' : 'muted' }, fmtDate(parseDate(g.closeDate))) : h('span', { class: 'muted' }, 'Rolling or TBD'))
          )
        )
      : [emptyRow(6, 'No grants match.')])
  );
}
