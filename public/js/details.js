// Side-panel detail views for an opportunity, a tracked contract, and a USAspending award.
import { state, actions, h, facts, tags, money, fmtDate, fmtStamp, parseDate, daysUntil, titleCase, setAsideLabel, noticeType, openDrawer } from './util.js';
import { reportsFor, startResearch, selectReport } from './research.js';

// Buttons that start AI research on the record, plus links to reports already written about it.
function researchSection(kind, subjectId, request) {
  const R = state.research;
  const existing = reportsFor(kind, subjectId);
  const run = (mode) => async (e) => {
    e.currentTarget.disabled = true;
    await startResearch({ ...request, kind, mode });
  };
  const off = R.enabled ? null : 'Add an OpenAI API key to the key file to switch this on';
  return [
    h('h3', null, 'Research'),
    h(
      'div',
      { class: 'actions', style: 'margin-top:6px' },
      h('button', { class: 'btn primary', type: 'button', disabled: !R.enabled, title: off, onclick: run('analysis') }, 'Analyze'),
      h('button', { class: 'btn', type: 'button', disabled: !R.enabled, title: off, onclick: run('contacts') }, 'Find contacts'),
      request.company ? h('button', { class: 'btn', type: 'button', onclick: () => actions.researchCompany(request.company) }, `Research ${request.company}`) : null
    ),
    existing.length
      ? h(
          'ul',
          { class: 'report-links' },
          existing.map((r) =>
            h(
              'li',
              null,
              h(
                'a',
                {
                  href: '#research',
                  onclick: (e) => {
                    e.preventDefault();
                    actions.closeDrawer();
                    actions.switchTab('research');
                    selectReport(r.id);
                  },
                },
                `${r.mode === 'contacts' ? 'Contacts' : 'Analysis'} from ${fmtStamp(new Date(r.createdAt))}`
              ),
              r.status === 'running' ? ' (in progress)' : r.status === 'error' ? ' (failed)' : null
            )
          )
        )
      : h('p', { class: 'muted', style: 'margin-top:6px;font-size:12.5px' }, R.enabled ? 'Runs an OpenAI web search on this record. Takes a minute or two.' : off),
  ];
}

const links = (...items) => h('div', { class: 'actions' }, items);
const link = (href, label) => (href ? h('a', { class: 'btn', href }, `${label} ↗`) : null);

export function showOpportunity(o) {
  const valueText = o.valueLow && o.valueHigh && o.valueLow !== o.valueHigh ? `${money(o.valueLow)} to ${money(o.valueHigh)}` : money(o.value);
  const saveBtn = h('button', { class: 'btn', type: 'button' });
  const paintSave = () => (saveBtn.textContent = o.saved ? '★ Saved' : '☆ Save');
  paintSave();
  saveBtn.addEventListener('click', async () => {
    await actions.toggleSaved(o);
    paintSave();
    actions.rerender();
  });
  openDrawer(
    h(
      'div',
      null,
      h('div', { class: 'eyebrow' }, `${o.agency?.name || o.lane} · ${noticeType(o)}`),
      h('h2', { id: 'drawer-title' }, o.title),
      h(
        'div',
        null,
        tags(o.themes.length ? o.themes : null),
        o.mentions.map((m) => h('span', { class: 'tag plain' }, `Mentions ${m}`)),
        (o.pursuits || []).map((id) => {
          const p = state.snap.pursuits.find((x) => x.id === id);
          return p ? h('button', { class: 'tag tracked', type: 'button', title: 'Open this effort on the tracking list', onclick: () => showPursuit(p) }, `Tracking: ${p.name}`) : null;
        })
      ),
      links(saveBtn, link(o.sourceUrl, 'Source notice'), link(o.url, 'HigherGov')),
      facts([
        ['Status', o.status[0].toUpperCase() + o.status.slice(1)],
        [o.status === 'forecast' ? 'Anticipated' : 'Response due', o.dueDate ? `${fmtDate(parseDate(o.dueDate))}${daysUntil(o.dueDate) >= 0 ? ` (${daysUntil(o.dueDate)} days)` : ''}` : '—'],
        ['Posted', o.postedDate ? fmtDate(parseDate(o.postedDate)) : '—'],
        ['Estimated value', valueText],
        ['Set-aside', setAsideLabel(o.setAside)],
        ['Fit', `${o.fit} of 100`],
        ['NAICS', o.naics],
        ['PSC', o.psc],
        ['Place of performance', o.pop],
        ['Vehicle', o.vehicle],
        ['Solicitation no.', o.sourceId?.replace(/^\*/, '')],
        ['Sole source', o.soleSource ? 'Yes' : null],
      ]),
      researchSection('opportunity', o.sourceKey, { id: o.id }),
      o.contacts?.length
        ? [
            h('h3', null, 'Contacts on the notice'),
            o.contacts.map((c) =>
              h(
                'div',
                { class: 'contact' },
                h('div', null, h('strong', null, c.name || '—'), c.title ? h('span', { class: 'muted' }, `, ${c.title}`) : null),
                h('div', null, c.email ? h('a', { href: `mailto:${c.email}` }, c.email) : null, c.email && c.phone ? ' · ' : null, c.phone ? h('span', { class: 'muted' }, c.phone) : null)
              )
            ),
          ]
        : null,
      o.hits?.length ? [h('h3', null, 'Why it matched'), h('div', null, o.hits.map((x) => h('span', { class: 'tag plain' }, x)))] : null,
      o.summary ? [h('h3', null, 'Summary (HigherGov)'), h('div', { class: 'prose' }, o.summary)] : null,
      o.description ? [h('h3', null, 'Description'), h('div', { class: 'prose' }, o.description)] : null
    )
  );
}

export function showContract(c) {
  const vendor = c.awardeeParent || c.awardee;
  openDrawer(
    h(
      'div',
      null,
      h('div', { class: 'eyebrow' }, `${c.agencyLabel} · ${c.awardingAgency?.name || 'Awarding office not listed'}`),
      h('h2', { id: 'drawer-title' }, `${vendor || 'Contract'} · ${c.awardId}`),
      h('div', null, tags(c.themes?.length ? c.themes : null), h('span', { class: `pill ${c.active ? 'ok' : ''}` }, c.active ? 'Active' : 'Ended')),
      links(link(c.url, 'HigherGov'), link(c.awardeeUrl, 'Vendor profile')),
      facts([
        ['Potential value', money(c.potentialValue)],
        ['Obligated', money(c.obligated)],
        ['Start', c.startDate ? fmtDate(parseDate(c.startDate)) : null],
        ['Current end', c.currentEndDate ? fmtDate(parseDate(c.currentEndDate)) : null],
        ['Potential end', c.potentialEndDate ? fmtDate(parseDate(c.potentialEndDate)) : null],
        ['Months left', c.potentialEndDate && c.active ? Math.round(daysUntil(c.potentialEndDate) / 30.4) : null],
        ['Vehicle', c.vehicle],
        ['Parent award', c.parentAwardId],
        ['Pricing', c.pricing],
        ['Competition', c.extentCompeted],
        ['Offers received', c.offers],
        ['Set-aside', c.setAside],
        ['PSC', c.psc ? `${c.psc} ${titleCase(c.pscName || '')}` : null],
        ['NAICS', c.naics ? `${c.naics} ${c.naicsName || ''}` : null],
      ]),
      researchSection('contract', `${c.agencyKey}:${c.awardId}`, { id: `${c.agencyKey}:${c.awardId}`, company: vendor }),
      c.relatedOpportunity ? [h('h3', null, 'Related opportunity'), h('div', { class: 'prose' }, c.relatedOpportunity)] : null,
      h('h3', null, 'Description'),
      h('div', { class: 'prose' }, c.description || '—')
    )
  );
}

export function showAward(a) {
  const vendor = titleCase(a.recipient);
  openDrawer(
    h(
      'div',
      null,
      h('div', { class: 'eyebrow' }, [a.agency, a.subAgency].filter(Boolean).join(' · ')),
      h('h2', { id: 'drawer-title' }, `${vendor} · ${a.awardId}`),
      h('div', null, tags(a.themes)),
      links(link(a.url, 'USAspending')),
      facts([
        ['Award amount', money(a.amount)],
        ['Start', a.startDate ? fmtDate(parseDate(a.startDate)) : null],
        ['End', a.endDate ? fmtDate(parseDate(a.endDate)) : null],
        ['Months left', a.endDate && daysUntil(a.endDate) >= 0 ? Math.round(daysUntil(a.endDate) / 30.4) : null],
        ['Funding office', a.fundingSubAgency],
        ['PSC', a.psc ? `${a.psc} ${titleCase(a.pscName || '')}` : null],
        ['NAICS', a.naics],
      ]),
      researchSection('contract', a.awardId, { id: a.awardId, company: vendor }),
      h('h3', null, 'Description'),
      h('div', { class: 'prose' }, a.description || '—')
    )
  );
}

// An effort on the tracking list: what is publicly known, the team's notes, and what the data holds.
export function showPursuit(p) {
  const R = state.research;
  const bySource = new Map(state.snap.opportunities.map((o) => [o.sourceKey, o]));
  const notices = p.notices.map((k) => bySource.get(k)).filter(Boolean);
  const off = R.enabled ? null : 'Add an OpenAI API key to the key file to switch this on';
  // Only the public name and scope go to the model, never the team's notes.
  const ask = (mode) => async (e) => {
    e.currentTarget.disabled = true;
    const label = `${p.agency} "${p.name}"${p.fullName && p.fullName !== p.name ? ` (${p.fullName})` : ''}`;
    await startResearch({
      kind: 'question',
      mode,
      question:
        mode === 'contacts'
          ? `Who are the government program and contracting contacts, and the incumbent's capture or program leads, for the ${label} contract effort?`
          : `What is publicly known about the ${label} contract effort? Cover scope of work, incumbent and team, contract vehicle, value, recompete timing, and which primes are likely to bid.`,
    });
  };
  const confidence = { high: 'Good public record', medium: 'Some public record', low: 'Thin public record', none: 'Nothing public found' }[p.confidence];
  openDrawer(
    h(
      'div',
      null,
      h('div', { class: 'eyebrow' }, `${p.agency} · Tracking list`),
      h('h2', { id: 'drawer-title' }, p.name),
      p.fullName && p.fullName !== p.name ? h('p', { class: 'muted', style: 'margin-top:2px' }, p.fullName) : null,
      h('div', { style: 'margin-top:8px' }, tags(p.topics.length ? p.topics : null), p.priority === 'high' ? h('span', { class: 'pill urgent' }, 'High priority') : null),
      facts([
        ['Timing', p.timing],
        ['Value', p.value],
        ['Incumbent', p.incumbents.join(', ')],
        ['Reference nos.', p.ids.join(', ')],
        ['Scope research', confidence],
      ]),
      h('h3', null, 'Scope of work'),
      h(
        'div',
        { class: 'prose' },
        p.scope || 'No public description of this effort was found. Notices that use its name will still be flagged here if one of the watched offices posts them.'
      ),
      p.notes || p.followUps.length
        ? [h('h3', null, 'Team notes'), p.notes ? h('div', { class: 'prose' }, p.notes) : null, p.followUps.length ? h('ul', { class: 'plain-list' }, p.followUps.map((x) => h('li', null, x))) : null]
        : null,
      h('h3', null, 'Research'),
      h(
        'div',
        { class: 'actions', style: 'margin-top:6px' },
        h('button', { class: 'btn primary', type: 'button', disabled: !R.enabled, title: off, onclick: ask('analysis') }, 'Research this effort'),
        h('button', { class: 'btn', type: 'button', disabled: !R.enabled, title: off, onclick: ask('contacts') }, 'Find contacts'),
        p.incumbents[0] ? h('button', { class: 'btn', type: 'button', onclick: () => actions.researchCompany(p.incumbents[0]) }, `Research ${p.incumbents[0]}`) : null
      ),
      h('h3', null, `Notices in the database (${notices.length})`),
      notices.length
        ? h(
            'ul',
            { class: 'rows compact' },
            notices.map((o) =>
              h(
                'li',
                { onclick: () => showOpportunity(o) },
                h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, o.title), h('div', { class: 'row-sub' }, [o.lane, noticeType(o), o.postedDate ? `posted ${fmtDate(parseDate(o.postedDate))}` : null].filter(Boolean).join(' · '))),
                h('div', { class: 'row-end' }, o.value ? money(o.value) : '')
              )
            )
          )
        : h('p', { class: 'muted', style: 'font-size:12.5px' }, 'None of the watched offices has posted a notice that names this effort.'),
      p.awardsSearched
        ? [
            h('h3', null, `Matching awards on USAspending (${p.awards.length})`),
            p.awards.length
              ? h(
                  'ul',
                  { class: 'rows compact' },
                  p.awards.map((a) =>
                    h(
                      'li',
                      { onclick: () => showAward({ ...a, themes: [] }) },
                      h(
                        'div',
                        { class: 'row-main' },
                        h('div', { class: 'row-title' }, `${titleCase(a.recipient)} · ${a.awardId}`),
                        h('div', { class: 'row-sub' }, [a.subAgency, a.endDate ? `ends ${fmtDate(parseDate(a.endDate))}` : null].filter(Boolean).join(' · '))
                      ),
                      h('div', { class: 'row-end' }, money(a.amount))
                    )
                  )
                )
              : h('p', { class: 'muted', style: 'font-size:12.5px' }, 'No award description names this effort.'),
          ]
        : null,
      p.keywords.length || p.codes.length ? [h('h3', null, 'Matched on'), h('div', null, [...p.codes, ...p.keywords].map((k) => h('span', { class: 'tag plain' }, k)))] : null,
      p.sources.length
        ? [
            h('h3', null, 'Sources'),
            h(
              'ul',
              { class: 'plain-list' },
              p.sources.map((u) => {
                let host = u;
                try {
                  host = new URL(u).hostname.replace(/^www\./, '');
                } catch {
                  /* keep the raw text */
                }
                return h('li', null, h('a', { href: u, target: '_blank', rel: 'noopener' }, host));
              })
            ),
          ]
        : null
    )
  );
}
