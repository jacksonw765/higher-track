// The Research tab: start AI reports, list past ones, and render the selected report.
import { state, actions, $, $$, h, api, markdown, hostOf, fmtStamp, closeDrawer } from './util.js';

const R = state.research;
const KIND_LABEL = { opportunity: 'Opportunity', contract: 'Contract', company: 'Company', question: 'Question' };
const MODE_LABEL = { analysis: 'Analysis', contacts: 'Contacts' };
const PLACEHOLDER = {
  question: 'Ask about the pipeline, an agency, an incumbent, a vehicle… e.g. "Which open notices suit a small business with zero trust past performance?"',
  company: 'Company name, e.g. Booz Allen Hamilton',
};
let composerKind = 'question';
let composerProblem = ''; // why the last request was refused, shown under the box until the next attempt
let pollTimer = null;

export const reportsFor = (kind, subjectId) => R.items.filter((r) => r.kind === kind && r.subjectId === subjectId);

export async function loadResearch() {
  const data = await api('/api/research');
  R.enabled = data.enabled;
  R.model = data.model;
  R.items = data.items;
  const running = R.items.filter((r) => r.status === 'running').length;
  $('#count-research').textContent = running ? `${running} running` : R.items.length || '';
  if (running) schedulePoll();
}

function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    const wasRunning = R.current?.status === 'running';
    try {
      await loadResearch();
      if (wasRunning) R.current = await api(`/api/research/${R.current.id}`);
    } catch {
      schedulePoll();
    }
    if (state.tab === 'research') renderResearch();
  }, 3000);
}

export async function selectReport(id) {
  R.selectedId = id;
  R.current = null;
  if (state.tab === 'research') renderResearch();
  try {
    R.current = await api(`/api/research/${id}`);
  } catch (error) {
    R.current = { id, status: 'error', error: error.message, subject: 'Report', kind: 'question', mode: 'analysis', createdAt: new Date().toISOString() };
  }
  if (state.tab === 'research') renderResearch();
}

// Starts a report and takes the user to it. Returns false if the server refused.
export async function startResearch(request) {
  composerProblem = '';
  try {
    const row = await api('/api/research', { method: 'POST', body: request });
    R.items.unshift(row);
    R.selectedId = row.id;
    R.current = row;
    closeDrawer();
    actions.switchTab('research');
    await loadResearch();
    renderResearch();
    return true;
  } catch (error) {
    composerProblem = error.message;
    closeDrawer();
    actions.switchTab('research');
    return false;
  }
}

export function researchCompany(name) {
  composerKind = 'company';
  closeDrawer();
  actions.switchTab('research');
  const input = $('#composer-input');
  input.value = name;
  input.focus();
}

async function submit(mode) {
  const text = $('#composer-input').value.trim();
  if (!text) return $('#composer-input').focus();
  const buttons = [$('#composer-analyze'), $('#composer-contacts')];
  buttons.forEach((b) => (b.disabled = true));
  const ok = await startResearch(composerKind === 'company' ? { kind: 'company', mode, name: text } : { kind: 'question', mode, question: text });
  buttons.forEach((b) => (b.disabled = !R.enabled));
  if (ok) $('#composer-input').value = '';
}

export function bindResearch() {
  $('#composer-kind').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    composerKind = b.dataset.v;
    composerProblem = '';
    renderResearch();
    $('#composer-input').focus();
  });
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    submit('analysis');
  });
  $('#composer-contacts').addEventListener('click', () => submit('contacts'));
  $('#composer-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit('analysis');
    }
  });
}

// ---------- Rendering ----------
function contactsTable(contacts) {
  return h(
    'table',
    { class: 'table' },
    h('thead', null, h('tr', null, h('th', null, 'Person'), h('th', null, 'Reach them'), h('th', null, 'Why'), h('th', null, 'Source'))),
    h(
      'tbody',
      null,
      contacts.map((c) =>
        h(
          'tr',
          null,
          h('td', null, h('div', { class: 'cell-title' }, c.name), h('div', { class: 'cell-sub' }, [c.title, c.organization].filter(Boolean).join(', '))),
          h(
            'td',
            { class: 'nowrap' },
            c.email ? h('div', null, h('a', { href: `mailto:${c.email}` }, c.email)) : null,
            c.phone ? h('div', { class: 'muted' }, c.phone) : null,
            !c.email && !c.phone ? h('span', { class: 'muted' }, 'Not published') : null
          ),
          h('td', { class: 'muted' }, c.why),
          h(
            'td',
            { class: 'nowrap' },
            /^https?:/i.test(c.source_url) ? h('a', { href: c.source_url }, hostOf(c.source_url)) : h('span', { class: 'muted' }, c.source_url || '—'),
            h('div', null, h('span', { class: `pill ${c.confidence === 'high' ? 'ok' : c.confidence === 'low' ? 'soon' : ''}` }, `${c.confidence} confidence`))
          )
        )
      )
    )
  );
}

function subjectLink(r) {
  if (r.kind === 'opportunity') {
    const o = state.snap?.opportunities.find((x) => x.sourceKey === r.subjectId);
    return o ? h('button', { class: 'btn small', type: 'button', onclick: () => actions.showOpportunity(o) }, 'View notice') : null;
  }
  if (r.kind === 'contract') {
    const c = state.snap?.agencies.flatMap((a) => a.contracts).find((x) => `${x.agencyKey}:${x.awardId}` === r.subjectId);
    return c ? h('button', { class: 'btn small', type: 'button', onclick: () => actions.showContract(c) }, 'View contract') : null;
  }
  return null;
}

function reportBody(r) {
  if (r.status === 'running') {
    return h(
      'div',
      null,
      h('div', { class: 'working' }, h('span', { class: 'spinner' }), h('span', null, `${r.stage || 'Working'}…`)),
      h('p', { class: 'report-meta' }, 'Usually one to three minutes. You can leave this page.')
    );
  }
  if (r.status === 'error') return h('div', { class: 'error-box' }, r.error || 'The report could not be completed.');
  const res = r.result;
  if (!res) return h('div', { class: 'empty' }, 'Loading…');
  return h(
    'div',
    null,
    h('div', { class: 'headline' }, res.headline),
    res.sections.map((s) => [h('h3', null, s.title), markdown(s.body)]),
    res.contacts.length ? [h('h3', null, 'Contacts'), contactsTable(res.contacts)] : null,
    res.next_steps.length ? [h('h3', null, 'Next steps'), h('ol', { class: 'md', style: 'padding-left:20px;margin:0' }, res.next_steps.map((s) => h('li', { style: 'margin:4px 0' }, s)))] : null,
    res.sources.length
      ? [h('h3', null, 'Sources'), h('ol', { class: 'sources' }, res.sources.map((s) => h('li', null, h('a', { href: s.url }, s.title || hostOf(s.url)), ` · ${hostOf(s.url)}`)))]
      : null,
    h(
      'p',
      { class: 'report-meta' },
      `${r.model}${res.meta?.searches ? `, ${res.meta.searches} web searches` : ''}. Check names, dates and figures at the source before relying on them.`
    )
  );
}

function renderReport() {
  const el = $('#report');
  const r = R.current;
  if (!R.selectedId) {
    return el.replaceChildren(
      h(
        'div',
        { class: 'empty' },
        R.items.length
          ? 'Select a report on the left.'
          : 'No reports yet. Ask a question above, or open any opportunity or contract and choose Analyze or Find contacts.'
      )
    );
  }
  if (!r) return el.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
  el.replaceChildren(
    h(
      'div',
      { class: 'report-head' },
      h('div', null, h('div', { class: 'eyebrow' }, `${KIND_LABEL[r.kind]} · ${MODE_LABEL[r.mode]} · ${fmtStamp(new Date(r.createdAt))}`), h('h2', null, r.subject)),
      h(
        'div',
        { class: 'actions', style: 'margin:0;flex:none' },
        subjectLink(r),
        r.status !== 'running'
          ? h(
              'button',
              {
                class: 'btn small',
                type: 'button',
                onclick: async () => {
                  await api(`/api/research/${r.id}`, { method: 'DELETE' });
                  R.selectedId = null;
                  R.current = null;
                  await loadResearch();
                  renderResearch();
                },
              },
              'Delete'
            )
          : null
      )
    ),
    // The list title is a shortened copy of a long question, so show the full text here.
    r.kind === 'question' && r.question !== r.subject ? h('p', { class: 'question' }, r.question) : '',
    reportBody(r)
  );
}

export function renderResearch() {
  $('#research-sub').textContent = R.enabled
    ? `Written by OpenAI ${R.model} with web search, only when you ask. Reports are saved here.`
    : 'AI research is off. Add your OpenAI API key as a second line in the key file (or set OPENAI_API_KEY) and restart the server.';
  $$('#composer-kind button').forEach((b) => b.classList.toggle('active', b.dataset.v === composerKind));
  const input = $('#composer-input');
  input.placeholder = PLACEHOLDER[composerKind];
  input.disabled = !R.enabled;
  $('#composer-analyze').disabled = $('#composer-contacts').disabled = !R.enabled;
  $('#composer-analyze').textContent = composerKind === 'company' ? 'Analyze company' : 'Ask';
  const hint = $('#composer-hint');
  hint.style.color = composerProblem ? 'var(--bad)' : '';
  hint.textContent =
    composerProblem || (composerKind === 'company' ? 'Pulls the company\u2019s federal awards from USAspending, then searches the web.' : 'Enter to send, Shift+Enter for a new line.');

  $('#history').replaceChildren(
    ...(R.items.length
      ? R.items.map((r) =>
          h(
            'li',
            { class: r.id === R.selectedId ? 'active' : null, onclick: () => selectReport(r.id) },
            h('div', { class: 'h-title' }, r.subject),
            h(
              'div',
              { class: 'h-sub' },
              r.status === 'running' ? [h('span', { class: 'spinner inline' }), ' Working… · '] : r.status === 'error' ? 'Failed · ' : null,
              `${KIND_LABEL[r.kind]} · ${MODE_LABEL[r.mode]} · ${fmtStamp(new Date(r.createdAt))}`
            )
          )
        )
      : [h('li', { class: 'empty-row' }, 'Nothing yet')])
  );
  renderReport();
}
