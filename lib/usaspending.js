const { fetchJson, num } = require('./util');

const BASE = 'https://api.usaspending.gov/api/v2';
const CONTRACT_TYPES = ['A', 'B', 'C', 'D'];

function post(path, body) {
  return fetchJson(`${BASE}${path}`, { method: 'POST', body, timeoutMs: 90000, retries: 2 });
}

// Keyword matches are scoped to IT, professional/analytic services, R&D, and IT products so that
// unrelated awards that merely mention a keyword (equipment buys, construction) drop out.
const KEYWORD_PSC_SCOPE = {
  require: [
    ['Service', 'D'],
    ['Service', 'R'],
    ['Service', 'B'],
    ['Service', 'U'],
    ['Research and Development'],
    ...['70', '7A', '7B', '7E', '7F', '7G', '7H', '7J', '7K'].map((g) => ['Product', g]),
  ],
};
const AWARD_PSC = /^(D|R|B|U|A|7)/;

function filters({ keywords, agencies, recipient, start, end }) {
  const f = { time_period: [{ start_date: start, end_date: end }], award_type_codes: CONTRACT_TYPES };
  if (keywords) {
    f.keywords = keywords;
    f.psc_codes = KEYWORD_PSC_SCOPE;
  }
  if (agencies) f.agencies = agencies;
  if (recipient) f.recipient_search_text = [recipient];
  return f;
}

async function overTime(f) {
  const data = await post('/search/spending_over_time/', { group: 'fiscal_year', filters: f });
  return (data.results || [])
    .map((r) => ({ fy: Number(r.time_period.fiscal_year), amount: num(r.aggregated_amount) || 0 }))
    .sort((a, b) => a.fy - b.fy);
}

async function byCategory(category, f, limit = 15) {
  const data = await post(`/search/spending_by_category/${category}/`, { filters: f, limit, page: 1 });
  return (data.results || []).map((r) => ({
    name: r.name || r.code || 'Unknown',
    code: r.code || null,
    amount: num(r.amount) || 0,
  }));
}

const AWARD_FIELDS = [
  'Award ID',
  'Recipient Name',
  'Award Amount',
  'Awarding Agency',
  'Awarding Sub Agency',
  'Funding Sub Agency',
  'Description',
  'Start Date',
  'End Date',
  'generated_internal_id',
  'PSC',
  'NAICS',
];

async function topAwards(f, limit = 100) {
  const data = await post('/search/spending_by_award/', {
    filters: f,
    fields: AWARD_FIELDS,
    limit,
    page: 1,
    sort: 'Award Amount',
    order: 'desc',
  });
  return (data.results || []).map((r) => ({
    awardId: r['Award ID'],
    recipient: r['Recipient Name'],
    amount: num(r['Award Amount']) || 0,
    agency: r['Awarding Agency'],
    subAgency: r['Awarding Sub Agency'],
    fundingSubAgency: r['Funding Sub Agency'],
    description: r['Description'] || '',
    startDate: r['Start Date'] || null,
    endDate: r['End Date'] || null,
    psc: r.PSC?.code || null,
    pscName: r.PSC?.description || null,
    naics: r.NAICS?.code || null,
    url: r.generated_internal_id ? `https://www.usaspending.gov/award/${r.generated_internal_id}` : null,
  }));
}

// One profile = trend + who buys + who wins + biggest awards for a filter set.
async function profile({ keywords, agencies, window, trendStart, includeAgencies = true, includePsc = false }) {
  const scoped = filters({ keywords, agencies, start: window.start, end: window.end });
  const trend = filters({ keywords, agencies, start: trendStart, end: window.end });
  const [trendRes, agenciesRes, recipientsRes, pscRes, awardsRes] = await Promise.allSettled([
    overTime(trend),
    includeAgencies ? byCategory('awarding_subagency', scoped, 15) : Promise.resolve([]),
    byCategory('recipient', scoped, 25),
    includePsc ? byCategory('psc', scoped, 15) : Promise.resolve([]),
    topAwards(scoped, 100),
  ]);
  const errors = [trendRes, agenciesRes, recipientsRes, pscRes, awardsRes]
    .filter((r) => r.status === 'rejected')
    .map((r) => String(r.reason?.message || r.reason));
  const value = (r) => (r.status === 'fulfilled' ? r.value : []);
  return {
    overTime: value(trendRes),
    agencies: value(agenciesRes),
    recipients: value(recipientsRes),
    psc: value(pscRes),
    topAwards: keywords ? value(awardsRes).filter((a) => !a.psc || AWARD_PSC.test(a.psc)) : value(awardsRes),
    errors,
  };
}

// Federal contract footprint of one company, matched by recipient name.
async function company(name, { window, trendStart }) {
  const scoped = filters({ recipient: name, start: window.start, end: window.end });
  const trend = filters({ recipient: name, start: trendStart, end: window.end });
  const [trendRes, agenciesRes, pscRes, namesRes, awardsRes] = await Promise.allSettled([
    overTime(trend),
    byCategory('awarding_subagency', scoped, 10),
    byCategory('psc', scoped, 10),
    byCategory('recipient', scoped, 8),
    topAwards(scoped, 20),
  ]);
  const value = (r) => (r.status === 'fulfilled' ? r.value : []);
  return {
    overTime: value(trendRes),
    agencies: value(agenciesRes),
    psc: value(pscRes),
    matchedRecipients: value(namesRes),
    topAwards: value(awardsRes),
  };
}

// Largest contract awards matching any of the keywords (a loose text match that also covers award
// numbers), optionally limited to one department on the awarding or the funding side. Several
// agency filters would be ANDed, so callers ask once per side. No PSC scoping: callers filter.
async function awardSearch({ keywords, toptier, side = 'funding', start, end, limit = 60 }) {
  const f = { time_period: [{ start_date: start, end_date: end }], award_type_codes: CONTRACT_TYPES, keywords };
  if (toptier) f.agencies = [{ type: side, tier: 'toptier', name: toptier }];
  return topAwards(f, limit);
}

module.exports = { profile, company, awardSearch };
