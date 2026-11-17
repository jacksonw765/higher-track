// Entry point: loads the snapshot, wires up navigation and refresh, and hands off to the views.
import { state, actions, $, $$, h, api, int, fmtStamp, parseDate, closeDrawer, tip, isActionable } from './util.js';
import { renderOverview, renderOpportunities, renderTracking, renderAgencies, renderMarket, renderGrants, buildControls, exportCsv } from './views.js';
import { renderResearch, loadResearch, bindResearch, researchCompany } from './research.js';
import { showOpportunity, showContract, showAward, showPursuit } from './details.js';

const RENDERERS = {
  overview: renderOverview,
  opportunities: renderOpportunities,
  tracking: renderTracking,
  agencies: renderAgencies,
  market: renderMarket,
  grants: renderGrants,
  research: renderResearch,
};

function rerender() {
  if (state.snap) RENDERERS[state.tab]();
}

function switchTab(tab) {
  if (!RENDERERS[tab]) tab = 'overview';
  state.tab = tab;
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.panel').forEach((p) => (p.hidden = !state.snap || p.dataset.panel !== tab));
  tip.hide();
  rerender();
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
  window.scrollTo(0, 0);
}

async function toggleSaved(o) {
  o.saved = !o.saved;
  try {
    await api('/api/saved', { method: 'POST', body: { sourceKey: o.sourceKey, saved: o.saved } });
  } catch {
    o.saved = !o.saved;
  }
}

Object.assign(actions, { switchTab, rerender, toggleSaved, showOpportunity, showContract, showAward, showPursuit, researchCompany, closeDrawer });

// ---------- Sidebar status ----------
function renderStatus() {
  const s = state.snap;
  const line = $('#data-status');
  const refreshBtn = $('#refresh-btn');
  refreshBtn.disabled = $('#resync-btn').disabled = state.refreshing;
  refreshBtn.replaceChildren(state.refreshing ? 'Refreshing…' : 'Refresh data');
  if (!s) return;

  const when = s.refreshedAt ? new Date(s.refreshedAt) : null;
  const ageHours = when ? (Date.now() - when) / 36e5 : Infinity;
  line.classList.toggle('stale', !state.refreshing && ageHours > 36);
  line.textContent = state.refreshing
    ? 'Pulling new records. The page updates when it finishes.'
    : when
      ? `Data as of ${fmtStamp(when)}${ageHours > 36 ? `, ${Math.floor(ageHours / 24)} day${ageHours >= 48 ? 's' : ''} old` : ''}. Stored locally.`
      : 'No data yet.';

  const q = s.quota;
  const share = q.used / q.monthlyAllowance;
  $('#quota-fill').style.width = `${Math.min(100, share * 100)}%`;
  $('#quota-fill').classList.toggle('high', share > 0.8);
  $('#quota-text').textContent = `${int(q.used)} of ${int(q.monthlyAllowance)} HigherGov records this month`;
  $('#quota').title = `${
    q.correctedAt ? `Matched to your HigherGov account on ${fmtStamp(new Date(q.correctedAt))}, plus everything pulled since.` : 'Every record this dashboard has pulled this month.'
  } HigherGov does not report usage through its API, so calls made outside this dashboard are not included. The last refresh used ${int(q.lastRunRecords)}.`;

  const notice = $('#notice');
  const problems = s.errors || [];
  notice.classList.toggle('hidden', !problems.length);
  if (problems.length) {
    notice.replaceChildren(
      h('strong', null, 'The last refresh was incomplete.'),
      ' What is shown may be missing recent changes.',
      h('ul', null, [...new Set(problems)].slice(0, 4).map((p) => h('li', null, p)))
    );
  }

  $('#count-opps').textContent = s.opportunities.filter((o) => o.relevant && isActionable(o)).length || '';
  $('#count-tracking').textContent = s.pursuits.length || '';
  $('#count-grants').textContent = s.grants.filter((g) => g.titleMatch).length || '';
  $('#footer').textContent = `Sources: HigherGov (${s.config.lookbackDays}-day look-back), USAspending.gov, Grants.gov.`;
}

// ---------- Data loading ----------
async function loadSnapshot() {
  const snap = await api('/api/snapshot');
  for (const o of snap.opportunities) {
    o._hay = [o.title, o.summary, o.description, o.agency?.name, o.agency?.abbr, o.lane, o.naics, o.psc, o.type, o.setAside, o.sourceId, (o.hits || []).join(' ')].join(' ').toLowerCase();
  }
  state.snap = snap;
  state.today = parseDate(snap.asOf);
  state.themes = snap.config.themes;
  state.themeById = Object.fromEntries(state.themes.map((t) => [t.id, t]));
  buildControls();
  renderStatus();

  const waiting = snap.empty;
  $('#loading').classList.toggle('hidden', !waiting);
  if (waiting) {
    $('#loading-title').textContent = 'Building the database';
    $('#loading-detail').textContent = 'First run: pulling opportunities, contracts and spending history. This takes a minute or two and only happens once; after that, data loads instantly from disk.';
    $$('.panel').forEach((p) => (p.hidden = true));
  } else switchTab(state.tab);
}

async function pollStatus() {
  let delay = 30000;
  try {
    const st = await api('/api/status');
    const changed = state.refreshing !== st.refreshing;
    state.refreshing = st.refreshing;
    if (state.snap && st.dataVersion !== state.snap.dataVersion) await loadSnapshot();
    else if (changed) renderStatus();
    if (st.refreshing || state.snap?.empty) delay = 2500;
  } catch {
    $('#data-status').textContent = 'Cannot reach the server. Retrying…';
    delay = 5000;
  }
  clearTimeout(pollStatus.timer);
  pollStatus.timer = setTimeout(pollStatus, delay);
}

async function requestRefresh(full) {
  if (full && !confirm('Pull the whole look-back window again? This re-downloads every notice and contract and uses more of the monthly HigherGov allowance than a normal refresh.')) return;
  state.refreshing = true;
  renderStatus();
  try {
    await api('/api/refresh', { method: 'POST', body: { full } });
  } catch (error) {
    state.refreshing = false;
    renderStatus();
    $('#data-status').textContent = `Refresh could not start: ${error.message}`;
  }
  pollStatus();
}

// The API cannot tell us what HigherGov has billed, so the user can type in the figure from
// their account and the counter carries on from there.
async function correctQuota() {
  const q = state.snap?.quota;
  if (!q) return;
  const answer = prompt('Records used this month, as shown in your HigherGov account (gear icon, then API):', q.used);
  if (answer == null) return;
  const used = Number(answer.replace(/[,\s]/g, ''));
  if (!Number.isInteger(used) || used < 0) return alert('Enter a whole number, for example 1515.');
  try {
    Object.assign(q, await api('/api/quota', { method: 'POST', body: { used } }));
    renderStatus();
  } catch (error) {
    alert(error.message);
  }
}

function paintThemeButton() {
  $('#theme-btn').textContent = document.documentElement.dataset.theme === 'dark' ? 'Light mode' : 'Dark mode';
}

// ---------- Events ----------
function bind() {
  paintThemeButton();
  $('#theme-btn').addEventListener('click', () => {
    window.toggleTheme();
    paintThemeButton();
  });
  $('#quota-fix').addEventListener('click', correctQuota);
  $$('#nav button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  window.addEventListener('hashchange', () => RENDERERS[location.hash.slice(1)] && location.hash.slice(1) !== state.tab && switchTab(location.hash.slice(1)));
  $('#refresh-btn').addEventListener('click', () => requestRefresh(false));
  $('#resync-btn').addEventListener('click', () => requestRefresh(true));

  const f = state.filters;
  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      f.q = e.target.value.trim();
      renderOpportunities();
    }, 140);
  });
  const pick = (sel, apply) =>
    $(sel).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      apply(b);
      rerender();
    });
  pick('#filter-status', (b) => (f.status = b.dataset.v));
  pick('#filter-themes', (b) => (f.themes.has(b.dataset.theme) ? f.themes.delete(b.dataset.theme) : f.themes.add(b.dataset.theme)));
  pick('#market-theme', (b) => (state.marketTheme = b.dataset.v));
  pick('#agency-picker', (b) => (state.agencyKey = Number(b.dataset.v)));
  const change = (sel, apply) =>
    $(sel).addEventListener('change', (e) => {
      apply(e.target);
      rerender();
    });
  change('#filter-agency', (t) => (f.agency = t.value));
  change('#filter-setaside', (t) => (f.setAside = t.value));
  change('#filter-relevant', (t) => (f.relevant = t.checked));
  change('#filter-saved', (t) => (f.saved = t.checked));
  change('#filter-tracked', (t) => {
    f.tracked = t.checked;
    f.pursuit = null;
  });
  const tr = state.tracking;
  change('#tracking-org', (t) => (tr.org = t.value));
  change('#tracking-active', (t) => (tr.active = t.checked));
  change('#tracking-priority', (t) => (tr.priority = t.checked));
  let trackingTimer;
  $('#tracking-search').addEventListener('input', (e) => {
    clearTimeout(trackingTimer);
    trackingTimer = setTimeout(() => {
      tr.q = e.target.value.trim();
      renderTracking();
    }, 140);
  });
  change('#grants-title-only', (t) => (state.grantsTitleOnly = t.checked));
  $('#export-csv').addEventListener('click', exportCsv);
  $('#opp-table thead').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const key = th.dataset.sort;
    state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : ['fit', 'value', 'postedDate'].includes(key) ? -1 : 1 };
    renderOpportunities();
  });
  bindResearch();

  let resizeTimer;
  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(rerender, 180);
  });

  const initial = location.hash.slice(1);
  if (RENDERERS[initial]) state.tab = initial;
}

async function boot() {
  bind();
  $('#loading-title').textContent = 'Loading';
  try {
    await loadResearch().catch(() => {});
    await loadSnapshot();
  } catch (error) {
    $('#loading-title').textContent = 'Could not load the dashboard';
    $('#loading-detail').textContent = error.message;
  }
  pollStatus();
}

boot();
