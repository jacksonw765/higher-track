// AI research: gathers what the database and USAspending know about a subject, hands it to an
// OpenAI model with web search switched on, and stores the structured report in SQLite.

const config = require('./config');
const store = require('./db');
const usaspending = require('./usaspending');
const { THEMES } = require('./taxonomy');
const { today, fiscalYearOf } = require('./util');

const OPENAI_URL = 'https://api.openai.com/v1/responses';
const MAX_RUNNING = 3;
const KINDS = ['opportunity', 'contract', 'company', 'question'];
let running = 0;

const redact = (text) => (config.openaiKey ? String(text).split(config.openaiKey).join('***') : String(text));
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');
const usd = (v) => (v == null ? 'n/a' : `$${Math.round(v).toLocaleString('en-US')}`);

class InputError extends Error {}

// ---------- Local lookups ----------

const STOP = new Set(
  'the and for with from that this are was will have has not all any can may our its into under over per about what which who whom when where how does did should would could give find show tell list contract contracts opportunity opportunities company companies services service support federal government agency'.split(
    ' '
  )
);
const words = (s) => [...new Set((s || '').toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || [])].filter((w) => !STOP.has(w));

function rank(items, query, fields, limit) {
  const q = words(query);
  if (!q.length) return [];
  return items
    .map((item) => {
      let score = 0;
      for (const [text, weight] of fields(item)) {
        const hay = (text || '').toLowerCase();
        for (const w of q) if (hay.includes(w)) score += weight;
      }
      return { item, score };
    })
    .filter((r) => r.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.item);
}

function allContracts() {
  return config.agencies.flatMap((a) => store.contractsFor(a.key).contracts.map((c) => ({ ...c, agencyKey: a.key, agencyLabel: a.label })));
}

function contractLine(c) {
  return [
    `- ${c.awardeeParent || c.awardee || 'Unknown vendor'} | ${c.awardId} | ${c.agencyLabel}`,
    `potential ${usd(c.potentialValue)}, obligated ${usd(c.obligated)}`,
    `${c.startDate || '?'} to ${c.potentialEndDate || c.currentEndDate || '?'}`,
    c.vehicle ? `vehicle ${c.vehicle}` : null,
    clip(c.description, 220),
  ]
    .filter(Boolean)
    .join(' | ');
}

function opportunityBlock(o, descriptionLimit) {
  const lines = [
    `Title: ${o.title}`,
    `Agency: ${o.agency?.name || 'n/a'}`,
    `Notice type: ${o.type || o.sourceType || 'n/a'}`,
    `Source ID: ${o.sourceId || 'n/a'}`,
    `Posted: ${o.postedDate || 'n/a'}   Due / anticipated: ${o.dueDate || 'n/a'}`,
    `Estimated value: ${o.valueLow || o.valueHigh ? `${usd(o.valueLow)} to ${usd(o.valueHigh)}` : 'not disclosed'}`,
    `Set-aside: ${o.setAside || 'none stated'}   NAICS: ${o.naics || 'n/a'}   PSC: ${o.psc || 'n/a'}`,
    o.vehicle ? `Vehicle: ${o.vehicle}` : null,
    o.pop ? `Place of performance: ${o.pop}` : null,
    o.soleSource ? 'Flagged sole source' : null,
    o.sourceUrl ? `Source notice: ${o.sourceUrl}` : null,
    o.url ? `HigherGov page: ${o.url}` : null,
    (o.contacts || []).length
      ? `Contacts printed on the notice:\n${o.contacts.map((c) => `  - ${[c.name, c.title, c.email, c.phone].filter(Boolean).join(', ')}`).join('\n')}`
      : null,
    o.summary ? `Summary: ${clip(o.summary, 1500)}` : null,
    o.description ? `Description:\n${clip(o.description, descriptionLimit)}` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

// ---------- Scraping ----------

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[|.*\.(local|internal)$)/i;

// Best-effort fetch of a public page as plain text. Many government sites render in the browser
// and return nothing useful; the model's own web search covers those.
async function pageText(url, limit = 6000) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || PRIVATE_HOST.test(u.hostname)) return '';
    const res = await fetch(u, {
      headers: { 'User-Agent': 'Mozilla/5.0 (opportunity-dashboard research)', Accept: 'text/html,text/plain' },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });
    if (!res.ok || !/text\/(html|plain)/.test(res.headers.get('content-type') || '')) return '';
    const html = (await res.text()).slice(0, 600000);
    const text = html
      .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#?\w+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > 400 ? clip(text, limit) : '';
  } catch {
    return '';
  }
}

// ---------- Context builders ----------

function marketWindow() {
  const t = today();
  const fy = fiscalYearOf(t);
  return { window: { start: `${fy - 4}-10-01`, end: t }, trendStart: `${fy - 6}-10-01` };
}

async function opportunityContext(id) {
  const all = store.allOpportunities();
  const o = all.find((x) => x.id === id) || all.find((x) => store.sourceKeyOf(x) === id);
  if (!o) throw new InputError('That opportunity is not in the database.');
  const related = rank(
    allContracts(),
    `${o.title} ${o.vehicle || ''}`,
    (c) => [
      [c.description, 1],
      [c.relatedOpportunity, 2],
    ],
    8
  );
  const scraped = o.sourceUrl ? await pageText(o.sourceUrl) : '';
  return {
    subject: o.title,
    subjectId: store.sourceKeyOf(o),
    text: [
      '## Opportunity record (HigherGov)',
      opportunityBlock(o, 9000),
      related.length
        ? `## Tracked contracts with similar wording (possible incumbents or adjacent work - verify before relying on them)\n${related.map(contractLine).join('\n')}`
        : null,
      scraped ? `## Text scraped from the source notice page\n${scraped}` : null,
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
}

function contractContext(id) {
  const tracked = allContracts().find((c) => `${c.agencyKey}:${c.awardId}` === id || c.awardId === id);
  if (tracked) {
    const c = tracked;
    return {
      subject: `${c.awardeeParent || c.awardee || 'Contract'} - ${c.awardId}`,
      subjectId: `${c.agencyKey}:${c.awardId}`,
      text: [
        '## Contract record (HigherGov)',
        `Award ID: ${c.awardId}${c.parentAwardId ? `   Parent award: ${c.parentAwardId}` : ''}`,
        `Awardee: ${c.awardee || 'n/a'}${c.awardeeParent && c.awardeeParent !== c.awardee ? ` (parent ${c.awardeeParent})` : ''}`,
        `Funding agency: ${c.fundingAgency?.name || 'n/a'}   Awarding office: ${c.awardingAgency?.name || 'n/a'}`,
        `Potential value: ${usd(c.potentialValue)}   Current value: ${usd(c.currentValue)}   Obligated: ${usd(c.obligated)}`,
        `Period of performance: ${c.startDate || '?'} to ${c.currentEndDate || '?'} (potential end ${c.potentialEndDate || '?'})`,
        `Vehicle: ${c.vehicle || 'none'}   Type: ${c.awardType || 'n/a'}   Pricing: ${c.pricing || 'n/a'}`,
        `Competition: ${c.extentCompeted || 'n/a'}   Offers received: ${c.offers ?? 'n/a'}   Set-aside: ${c.setAside || 'none'}`,
        `PSC: ${c.psc || 'n/a'} ${c.pscName || ''}   NAICS: ${c.naics || 'n/a'} ${c.naicsName || ''}`,
        c.relatedOpportunity ? `Related opportunity: ${c.relatedOpportunity}` : null,
        c.url ? `HigherGov page: ${c.url}` : null,
        `Description: ${clip(c.description, 3000)}`,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }
  for (const theme of THEMES) {
    const a = (store.getCache(`market:${theme.id}`)?.value?.topAwards || []).find((x) => x.awardId === id);
    if (!a) continue;
    return {
      subject: `${a.recipient} - ${a.awardId}`,
      subjectId: a.awardId,
      text: [
        '## Award record (USAspending)',
        `Award ID: ${a.awardId}`,
        `Recipient: ${a.recipient}`,
        `Awarding agency: ${a.agency} / ${a.subAgency}   Funding: ${a.fundingSubAgency || 'n/a'}`,
        `Award amount: ${usd(a.amount)}   Period: ${a.startDate || '?'} to ${a.endDate || '?'}`,
        `PSC: ${a.psc || 'n/a'} ${a.pscName || ''}   NAICS: ${a.naics || 'n/a'}`,
        a.url ? `USAspending page: ${a.url}` : null,
        `Description: ${clip(a.description, 3000)}`,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }
  throw new InputError('That contract is not in the database.');
}

async function companyContext(name) {
  const profile = await usaspending.company(name, marketWindow()).catch(() => null);
  const needle = name.toLowerCase();
  const tracked = allContracts().filter((c) => `${c.awardee} ${c.awardeeParent}`.toLowerCase().includes(needle));
  const parts = [`## Company\n${name}`];
  if (profile && profile.topAwards.length) {
    parts.push(
      [
        '## Federal prime contract footprint (USAspending, matched on recipient name - may mix in similarly named firms)',
        `Recipient names matched: ${profile.matchedRecipients.map((r) => r.name).join('; ') || 'n/a'}`,
        `Obligations by fiscal year: ${profile.overTime.map((r) => `FY${r.fy} ${usd(r.amount)}`).join(', ')}`,
        `Top awarding agencies (last 4 FY): ${profile.agencies.map((r) => `${r.name} ${usd(r.amount)}`).join('; ')}`,
        `Top product/service codes: ${profile.psc.map((r) => `${r.code} ${r.name} ${usd(r.amount)}`).join('; ')}`,
        'Largest awards:',
        ...profile.topAwards
          .slice(0, 15)
          .map((a) => `- ${a.awardId} | ${a.subAgency} | ${usd(a.amount)} | ${a.startDate || '?'} to ${a.endDate || '?'} | ${clip(a.description, 160)}`),
      ].join('\n')
    );
  } else {
    parts.push('## Federal prime contract footprint\nNo prime contract awards were found on USAspending under this name in the last four fiscal years.');
  }
  if (tracked.length) parts.push(`## Contracts held at watched agencies (HigherGov)\n${tracked.slice(0, 12).map(contractLine).join('\n')}`);
  return { subject: name, subjectId: needle, text: parts.join('\n\n') };
}

function questionContext(question) {
  const t = today();
  const opps = rank(
    store.allOpportunities().filter((o) => !o.dueDate || o.dueDate >= t || (o.postedDate || '') >= `${fiscalYearOf(t) - 1}-10-01`),
    question,
    (o) => [
      [o.title, 3],
      [o.agency?.name, 2],
      [o.agency?.abbr, 2],
      [o.summary, 1],
      [o.description, 1],
    ],
    8
  );
  const contracts = rank(
    allContracts(),
    question,
    (c) => [
      [c.description, 2],
      [`${c.awardee} ${c.awardeeParent}`, 3],
      [c.agencyLabel, 2],
      [c.vehicle, 2],
    ],
    8
  );
  const parts = [];
  if (opps.length) parts.push(`## Opportunities in the local database that match the question\n${opps.map((o) => opportunityBlock(o, 900)).join('\n\n---\n\n')}`);
  if (contracts.length) parts.push(`## Tracked contracts that match the question\n${contracts.map(contractLine).join('\n')}`);
  if (!parts.length) parts.push('No records in the local database matched the question; rely on web search.');
  return { subject: clip(question, 90), subjectId: null, text: parts.join('\n\n') };
}

// ---------- Prompting ----------

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'sections', 'contacts', 'next_steps', 'sources'],
  properties: {
    headline: { type: 'string', description: 'The bottom line in one sentence, 30 words at most.' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'body'],
        properties: {
          title: { type: 'string' },
          body: { type: 'string', description: 'Markdown. At most 4 one-sentence bullets or one 70-word paragraph. No links, headings or tables.' },
        },
      },
    },
    contacts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'title', 'organization', 'email', 'phone', 'why', 'source_url', 'confidence'],
        properties: {
          name: { type: 'string' },
          title: { type: 'string' },
          organization: { type: 'string' },
          email: { type: 'string', description: 'Empty string unless a source prints it.' },
          phone: { type: 'string', description: 'Empty string unless a source prints it.' },
          why: { type: 'string', description: 'Why this person matters, 12 words at most.' },
          source_url: { type: 'string', description: 'Where the person and role were confirmed; "Notice" if from the supplied record.' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
    next_steps: { type: 'array', items: { type: 'string' } },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'url'],
        properties: { title: { type: 'string' }, url: { type: 'string' } },
      },
    },
  },
};

const INSTRUCTIONS = `You are a federal business-development analyst. Your reader is a capture manager at a government contractor that pursues ${THEMES.map((t) => t.label).join(', ')} work. They read this between meetings and want the answer, not the research trail.

How to work:
- Treat the records supplied in the request as accurate. Use web search to fill the gaps: the notice and its attachments, agency forecasts, prior awards on USAspending or FPDS, press releases, company websites and leadership pages.
- Be specific: names, dates, dollar figures, contract numbers, vehicles. If something cannot be established, say so in a few words and move on.
- Today's date is ${today()}.

Length - these are hard limits:
- headline: one sentence, 30 words at most.
- Each section: at most 4 bullets of one sentence each, or one paragraph of 70 words. Lead with the fact. No introductions, no summaries of what was just said, no explaining how you found it.
- Do not put links, citations or source names in the section text; sources belong in the sources list only.
- next_steps: at most 4, each one sentence starting with a verb.
- sources: the 8 most useful pages at most.

Contacts:
- List a person only when a source confirms both who they are and their role. Include contacts printed on a supplied notice (source_url "Notice", confidence "high").
- Give an email address or phone number only if a source prints it. Never construct an address from a naming pattern. Leave the field empty otherwise.
- Pick the people who can actually help rather than listing a whole leadership page. "why" is 12 words at most.
- Set confidence to "low" when the role may be out of date.`;

const CONTACT_CAP = { analysis: 'List at most 4 contacts.', contacts: 'List at most 10 contacts, most useful first.' };

const TASKS = {
  opportunity: {
    analysis:
      'Analyze this opportunity. Sections, in order: "What they are buying", "Incumbent" (who holds the current or predecessor contract, its value and end date), "Competition" (likely bidders and the one reason each matters), "Fit and risks" (set-aside, vehicle access, clearances, timeline).',
    contacts:
      'Find the people to contact about this opportunity: contracting officer and specialist, program office leads, the agency small-business specialist, and the incumbent\'s program or capture lead if identifiable. One section only, "Who matters", on the buying office.',
  },
  contract: {
    analysis:
      'Analyze this contract as a recompete target. Sections, in order: "What it covers", "Incumbent and history", "Recompete outlook" (when, on what vehicle, anything already published), "How to position" (prime, team or pass, and with whom).',
    contacts:
      'Find the people to contact about this contract and its follow-on: contracting officer, program office leads, the agency small-business specialist, and the incumbent\'s program manager or capture lead. One section only, "Who matters".',
  },
  company: {
    analysis:
      'Profile this company for a contractor deciding whether to compete with it or team with it. Sections, in order: "Overview" (size, ownership, set-aside status, core offerings), "Federal footprint" (main customers, vehicles, contracts expiring soon), "Strengths and gaps", "Compete or team".',
    contacts:
      'Find the right people to contact at this company about teaming or subcontracting: business development, capture, contracts or partnership leads, plus any published teaming inbox. One section only, "Who matters", on how its federal business is organised.',
  },
  question: {
    analysis: 'Answer the question directly. Use as few sections as the answer needs, with titles that fit it. Include contacts only if they help answer it.',
    contacts: 'Answer the question with an emphasis on identifying the right people to contact. Use as few sections as the answer needs.',
  },
};

// ---------- OpenAI ----------

// Search results come back with a tracking parameter appended to every link.
const stripTracking = (s) => s.replace(/\?utm_source=openai&/g, '?').replace(/[?&]utm_source=openai/g, '');

function readResponse(data) {
  let text = '';
  const cited = new Map();
  for (const item of data.output || []) {
    if (item.type !== 'message') continue;
    for (const part of item.content || []) {
      if (part.type === 'refusal') throw new Error(`The model declined: ${part.refusal}`);
      if (part.type !== 'output_text') continue;
      text += part.text;
      for (const a of part.annotations || []) if (a.type === 'url_citation' && a.url) cited.set(stripTracking(a.url), a.title || a.url);
    }
  }
  if (!text) throw new Error(data.incomplete_details?.reason ? `The model stopped early (${data.incomplete_details.reason}).` : 'The model returned no text.');
  const report = JSON.parse(stripTracking(text));
  // Anything the model cited inline but left out of its source list still gets credited.
  const listed = new Set(report.sources.map((s) => s.url));
  for (const [url, title] of cited) if (!listed.has(url)) report.sources.push({ title, url });
  const seen = new Set();
  report.sources = report.sources.filter((s) => /^https?:\/\//i.test(s.url) && !seen.has(s.url) && seen.add(s.url));
  return report;
}

async function askModel(input) {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openaiKey}` },
    body: JSON.stringify({
      model: config.openaiModel,
      instructions: INSTRUCTIONS,
      input,
      tools: [{ type: 'web_search' }],
      text: { format: { type: 'json_schema', name: 'research_report', strict: true, schema: REPORT_SCHEMA } },
    }),
    signal: AbortSignal.timeout(285000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${data.error?.message || 'request failed'}`);
  const searches = (data.output || []).filter((i) => i.type === 'web_search_call').length;
  return { report: readResponse(data), searches, usage: data.usage || null };
}

// ---------- Entry point ----------

async function run(id, { kind, mode, question, contextPromise }) {
  running++;
  try {
    const context = await contextPromise;
    store.updateResearch(id, { stage: 'Searching the web and writing the report' });
    const input = [
      `${TASKS[kind][mode]} ${CONTACT_CAP[mode]}`,
      kind === 'question' ? `## Question\n${question}` : question ? `## Additional instructions from the user\n${question}` : null,
      context.text,
    ]
      .filter(Boolean)
      .join('\n\n');
    const { report, searches, usage } = await askModel(input);
    store.updateResearch(id, {
      status: 'done',
      stage: null,
      result: { ...report, meta: { searches, inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null } },
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error.name === 'TimeoutError' ? 'The model took too long to answer. Try again, or narrow the request.' : redact(error.message);
    store.updateResearch(id, { status: 'error', stage: null, error: message, finishedAt: new Date().toISOString() });
  } finally {
    running--;
  }
}

// Validates the request, records it, and starts the work in the background. Returns the new row id.
function start({ kind, mode = 'analysis', id, name, question }) {
  if (!config.openaiKey) throw new InputError('No OpenAI API key found. Add it as a second line in ./key (it starts with "sk-") or set OPENAI_API_KEY, then restart.');
  if (!KINDS.includes(kind)) throw new InputError('Unknown research type.');
  if (!['analysis', 'contacts'].includes(mode)) throw new InputError('Unknown research mode.');
  if (running >= MAX_RUNNING) throw new InputError('Three reports are already in progress. Wait for one to finish.');
  question = clip(String(question || '').trim(), 2000);
  name = String(name || '').trim().slice(0, 200);
  id = String(id || '').slice(0, 300);

  let subject;
  let subjectId = null;
  let contextPromise;
  if (kind === 'question') {
    if (question.length < 3) throw new InputError('Type a question first.');
    const ctx = questionContext(question);
    subject = ctx.subject;
    contextPromise = Promise.resolve(ctx);
  } else if (kind === 'company') {
    if (name.length < 2) throw new InputError('Enter a company name.');
    subject = name;
    subjectId = name.toLowerCase();
    contextPromise = companyContext(name);
  } else if (kind === 'contract') {
    const ctx = contractContext(id);
    ({ subject, subjectId } = ctx);
    contextPromise = Promise.resolve(ctx);
  } else {
    const all = store.allOpportunities();
    const o = all.find((x) => x.id === id) || all.find((x) => store.sourceKeyOf(x) === id);
    if (!o) throw new InputError('That opportunity is not in the database.');
    subject = o.title;
    subjectId = store.sourceKeyOf(o);
    contextPromise = opportunityContext(id);
  }

  const rowId = store.createResearch({ kind, mode, subjectId, subject, question, model: config.openaiModel });
  run(rowId, { kind, mode, question, contextPromise });
  return rowId;
}

module.exports = { start, InputError, enabled: Boolean(config.openaiKey) };
