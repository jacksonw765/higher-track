const { fetchJson, num } = require('./util');

const BASE = 'https://www.highergov.com/api-external';
const PAGE_SIZE = 100;

class BudgetExceededError extends Error {}

class HigherGovClient {
  constructor({ apiKey, recordBudget, timeoutMs, onUsage }) {
    this.apiKey = apiKey;
    this.recordBudget = recordBudget;
    this.timeoutMs = timeoutMs;
    this.onUsage = onUsage || (() => {});
    this.lifetime = { records: 0, calls: 0, startedAt: new Date().toISOString() };
    this.resetRun();
  }

  resetRun() {
    this.run = { records: 0, calls: 0, failures: 0 };
  }

  redact = (text) => (this.apiKey ? String(text).split(this.apiKey).join('***') : String(text));

  // HigherGov meters records returned (10k/month on standard plans), so every page is counted
  // and the run stops once its budget is spent.
  async get(endpoint, params) {
    if (!this.apiKey) throw new Error('No HigherGov API key configured (set HG_API_KEY or create ./key).');
    if (this.run.records >= this.recordBudget) {
      throw new BudgetExceededError(`Per-refresh record budget of ${this.recordBudget} reached`);
    }
    const url = new URL(`${BASE}/${endpoint}/`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
    url.searchParams.set('api_key', this.apiKey);

    this.run.calls++;
    this.lifetime.calls++;
    let data;
    try {
      data = await fetchJson(url, { timeoutMs: this.timeoutMs, redact: this.redact });
    } catch (error) {
      this.run.failures++;
      throw error;
    }
    const results = Array.isArray(data.results) ? data.results : [];
    this.run.records += results.length;
    this.lifetime.records += results.length;
    this.onUsage(results.length);
    const pagination = data.meta?.pagination || {};
    // `links` echoes the api_key back, so it is deliberately never read or forwarded.
    return { results, count: pagination.count ?? results.length, pages: pagination.pages ?? 1 };
  }

  async getAll(endpoint, params, { maxRecords = Infinity } = {}) {
    const all = [];
    let page = 1;
    let pages = 1;
    do {
      const remaining = maxRecords - all.length;
      const pageSize = Math.min(PAGE_SIZE, remaining);
      const res = await this.get(endpoint, { ...params, page_size: pageSize, page_number: page });
      all.push(...res.results);
      pages = res.pages;
      page++;
      if (res.results.length < pageSize) break;
    } while (page <= pages && all.length < maxRecords);
    return all;
  }
}

function slimAgency(a) {
  if (!a) return null;
  return { key: a.agency_key, name: a.agency_name, abbr: a.agency_abbreviation || null };
}

function slimPerson(p) {
  if (!p || !(p.contact_name || p.contact_email)) return null;
  return {
    name: p.contact_name || [p.contact_first_name, p.contact_last_name].filter(Boolean).join(' '),
    title: p.contact_title || null,
    email: p.contact_email || null,
    phone: p.contact_phone || null,
  };
}

function slimOpportunity(o) {
  return {
    id: o.opp_key || o.version_key || `${o.source_type}:${o.source_id}`,
    title: o.title || '(untitled)',
    description: o.description_text || '',
    summary: o.ai_summary || '',
    sourceType: o.source_type || null,
    sourceId: o.source_id || null,
    category: o.opp_cat || null,
    type: o.opp_type?.description || null,
    postedDate: o.posted_date ? o.posted_date.slice(0, 10) : null,
    dueDate: o.due_date ? o.due_date.slice(0, 10) : null,
    capturedDate: o.captured_date ? o.captured_date.slice(0, 10) : null,
    agency: slimAgency(o.agency),
    naics: o.naics_code?.naics_code || null,
    psc: o.psc_code?.psc_code || null,
    setAside: o.set_aside || null,
    vehicle: o.vehicle || null,
    soleSource: Boolean(o.sole_source_flag),
    valueLow: num(o.val_est_low),
    valueHigh: num(o.val_est_high),
    pop: [o.pop_city, o.pop_state].filter(Boolean).join(', ') || o.pop_country || null,
    contacts: [slimPerson(o.primary_contact_email), slimPerson(o.secondary_contact_email)].filter(Boolean),
    url: o.path || null,
    sourceUrl: o.source_path || null,
  };
}

function slimContract(c) {
  return {
    awardId: c.award_id,
    parentAwardId: c.parent_award_id || null,
    description: c.award_description_original || c.alt_description || '',
    relatedOpportunity: c.related_opportunity_title || null,
    awardee: c.awardee?.clean_name || null,
    awardeeParent: c.awardee_parent?.clean_name || c.awardee?.clean_name || null,
    awardeeUrl: c.awardee_parent?.path || c.awardee?.path || null,
    awardingAgency: slimAgency(c.awarding_agency),
    fundingAgency: slimAgency(c.funding_agency),
    vehicle: c.vehicle?.vehicle_name || null,
    awardType: c.award_type || null,
    pricing: c.type_of_contract_pricing_description || null,
    setAside: c.type_of_set_aside || null,
    extentCompeted: c.extent_competed || null,
    offers: num(c.number_of_offers_received),
    psc: c.psc_code?.psc_code || null,
    pscName: c.psc_code?.psc_name || null,
    naics: c.naics_code?.naics_code || null,
    naicsName: c.naics_code?.naics_description || null,
    obligated: num(c.total_dollars_obligated),
    currentValue: num(c.current_total_value_of_award),
    potentialValue: num(c.potential_total_value_of_award),
    startDate: c.period_of_performance_start_date?.slice(0, 10) || null,
    currentEndDate: c.period_of_performance_current_end_date?.slice(0, 10) || null,
    potentialEndDate: c.period_of_performance_potential_end_date?.slice(0, 10) || null,
    lastActionDate: c.latest_action_date?.slice(0, 10) || null,
    url: c.path || null,
  };
}

module.exports = { HigherGovClient, BudgetExceededError, slimOpportunity, slimContract };
