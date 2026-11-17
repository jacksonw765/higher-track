// Two halves: sync() pulls from the network into SQLite, buildSnapshot() reads SQLite and shapes
// what the browser sees. The dashboard always renders from the database, never from the network.

const config = require('./config');
const store = require('./db');
const { THEMES, classify } = require('./taxonomy');
const { HigherGovClient, BudgetExceededError, slimOpportunity, slimContract } = require('./highergov');
const usaspending = require('./usaspending');
const { fetchGrants } = require('./grants');
const pursuits = require('./pursuits');
const { today, addDays, lastNDays, fiscalYearOf, pool } = require('./util');

const hg = new HigherGovClient({
  apiKey: config.apiKey,
  recordBudget: config.recordBudgetPerRun,
  timeoutMs: config.requestTimeoutMs,
  onUsage: (records) => store.addUsage(today(), records),
});

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Acronyms match case-sensitively ("DISA" but not "disa"); full names match in any case.
const AGENCY_MENTIONS = config.agencies
  .filter((a) => a.aliases.length)
  .map((a) => ({
    label: a.label,
    patterns: a.aliases.map((alias) => new RegExp(`\\b${escapeRe(alias)}\\b`, alias === alias.toUpperCase() ? '' : 'i')),
  }));

function scopes() {
  return [
    ...config.agencies.map((a) => ({
      key: `agency:${a.key}`,
      label: a.label,
      kind: 'agency',
      params: { agency_key: a.key },
      dateField: 'posted_date',
      days: a.days || config.lookbackDays,
      refetch: a.page ? config.refetchRecentDays : config.watchRefetchDays,
    })),
    ...config.savedSearches.map((s) => ({
      key: `search:${s.id}`,
      label: s.label,
      kind: 'search',
      params: { search_id: s.id },
      dateField: 'captured_date',
      days: config.searchLookbackDays,
      refetch: config.refetchRecentDays,
    })),
  ];
}

function opportunityStatus(o, t) {
  const type = (o.type || '').toLowerCase();
  if (o.sourceType === 'forecast' || type.includes('forecast')) return 'forecast';
  // Sole-source justifications announce a decision already made, so they are not actionable.
  if (type.includes('award') || type.includes('justification')) return 'awarded';
  if (o.dueDate) return o.dueDate >= t ? 'open' : 'closed';
  return o.postedDate && o.postedDate >= addDays(t, -45) ? 'open' : 'closed';
}

// ---------- Sync: network -> SQLite ----------

async function syncOpportunities(errors, full) {
  const t = today();
  const jobs = [];
  for (const scope of scopes()) {
    const refetchFrom = addDays(t, -scope.refetch);
    const done = full ? new Set() : store.fetchedDays(scope.key);
    for (const day of lastNDays(scope.days, t)) {
      // Recent days are always re-pulled because notices get amended; older days only once.
      if (done.has(day) && day < refetchFrom) continue;
      jobs.push({
        day,
        run: async () => {
          const rows = await hg.getAll('opportunity', { ...scope.params, [scope.dateField]: day });
          store.saveDay(scope.key, day, rows.map(slimOpportunity));
        },
      });
    }
  }

  // Newest days first, so if the record budget runs out it is old history that waits.
  jobs.sort((a, b) => (a.day < b.day ? 1 : -1));
  const results = await pool(
    jobs.map((j) => j.run),
    config.concurrency
  );
  const failed = results.filter((r) => !r.ok);
  const overBudget = failed.filter((r) => r.error instanceof BudgetExceededError).length;
  if (overBudget) errors.push(`HigherGov record budget reached; ${overBudget} day-queries will be picked up by the next refresh.`);
  const other = failed.filter((r) => !(r.error instanceof BudgetExceededError));
  if (other.length) errors.push(`HigherGov: ${other.length} of ${jobs.length} day-queries failed (${hg.redact(other[0].error.message)}).`);
}

async function syncContracts(errors, full) {
  const t = today();
  for (const agency of config.agencies) {
    if (!agency.contracts) continue;
    const { fetchedOn } = store.contractsFor(agency.key);
    if (!full && fetchedOn && fetchedOn > addDays(t, -config.contractRefreshDays)) continue;
    try {
      const rows = await hg.getAll(
        'contract',
        {
          [agency.role === 'awarding' ? 'awarding_agency_key' : 'funding_agency_key']: agency.key,
          ordering: '-potential_total_value_of_award',
        },
        { maxRecords: agency.contracts }
      );
      store.replaceContracts(agency.key, rows.map(slimContract), t);
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        errors.push(`HigherGov record budget reached before ${agency.label} contracts; they will be picked up by the next refresh.`);
        return;
      }
      errors.push(`HigherGov contracts (${agency.label}): ${hg.redact(error.message)}`);
    }
  }
}

function marketWindow() {
  const t = today();
  const fy = fiscalYearOf(t);
  const startFy = fy - config.landscapeFiscalYears;
  return {
    currentFy: fy,
    startFy,
    window: { start: `${startFy - 1}-10-01`, end: t, label: `FY${String(startFy).slice(-2)}–FY${String(fy).slice(-2)} YTD` },
    trendStart: `${config.trendStartFiscalYear - 1}-10-01`,
  };
}

// A profile that came back empty because USAspending was down must not overwrite a good one.
function keepProfile(cacheKey, profile, label, errors) {
  profile.errors.forEach((e) => errors.push(`USAspending (${label}): ${e}`));
  const empty = !profile.overTime.length && !profile.recipients.length;
  delete profile.errors;
  if (empty && store.getCache(cacheKey)) return;
  store.setCache(cacheKey, profile);
}

async function syncMarket(errors) {
  const { window, trendStart } = marketWindow();
  const jobs = [
    ...THEMES.map((theme) => async () => {
      const profile = await usaspending.profile({ keywords: theme.usaspendingKeywords, window, trendStart });
      profile.topAwards = profile.topAwards.map((a) => ({ ...a, theme: theme.id }));
      keepProfile(`market:${theme.id}`, profile, theme.label, errors);
    }),
    ...config.agencies
      .filter((a) => a.page && a.usaspending)
      .map((agency) => async () => {
        const profile = await usaspending.profile({
          agencies: [{ type: agency.role, tier: 'subtier', name: agency.usaspending }],
          window,
          trendStart,
          includeAgencies: agency.role === 'funding',
          includePsc: true,
        });
        keepProfile(`agency:${agency.key}`, profile, agency.label, errors);
      }),
  ];
  const results = await pool(jobs, 2);
  results.filter((r) => !r.ok).forEach((r) => errors.push(`USAspending: ${r.error.message}`));
}

// Small buys that merely share a name (a part number, a ship) are not incumbent contracts.
const MIN_PURSUIT_AWARD = 250000;

// Incumbent contracts for the tracking list. Free (USAspending), refreshed weekly.
async function syncPursuitAwards(errors, full) {
  const t = today();
  const { trendStart } = marketWindow();
  const stale = addDays(t, -config.pursuitAwardRefreshDays);
  const jobs = pursuits.PURSUITS.filter(searched)
    .filter((p) => {
      const cached = store.getCache(`pursuit:${p.id}`);
      return full || !cached || cached.updatedAt.slice(0, 10) <= stale || cached.value.terms !== pursuits.awardTerms(p).join('|');
    })
    .map((p) => async () => {
      const keywords = pursuits.awardKeywords(p);
      const ids = pursuits.awardIdTerms(p);
      const range = { start: trendStart, end: t };
      // Award numbers are searched government-wide; names only within the department, on either
      // side of the award, because GSA often signs work that another department pays for.
      const found = (
        await Promise.all([
          ids.length ? usaspending.awardSearch({ keywords: ids, ...range }) : [],
          keywords.length ? usaspending.awardSearch({ keywords, toptier: p.toptier, side: 'funding', ...range }) : [],
          keywords.length ? usaspending.awardSearch({ keywords, toptier: p.toptier, side: 'awarding', ...range }) : [],
        ])
      ).flat();
      const byId = new Map(found.map((a) => [a.awardId, a]));
      const awards = [...byId.values()]
        .filter((a) => a.amount >= MIN_PURSUIT_AWARD && pursuits.matchAward(p, a))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 8);
      store.setCache(`pursuit:${p.id}`, { terms: pursuits.awardTerms(p).join('|'), awards });
    });
  const results = await pool(jobs, 2);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) errors.push(`USAspending: ${failed.length} of ${jobs.length} tracking-list award lookups failed (${failed[0].error.message}).`);
}

async function syncGrants(errors) {
  const byId = new Map();
  let failures = 0;
  let queries = 0;
  for (const theme of THEMES) {
    const { grants, errors: errs } = await fetchGrants(theme.grantsKeywords);
    queries += theme.grantsKeywords.length;
    failures += errs.length;
    errs.forEach((e) => errors.push(`Grants.gov: ${e}`));
    for (const g of grants) {
      const existing = byId.get(g.id);
      if (existing) {
        if (!existing.queryThemes.includes(theme.id)) existing.queryThemes.push(theme.id);
      } else {
        byId.set(g.id, { ...g, queryThemes: [theme.id] });
      }
    }
  }
  // Only replace the stored list when every query answered; a partial list would silently drop grants.
  if (!failures || !store.getCache('grants')) store.setCache('grants', [...byId.values()]);
  else errors.push(`Grants.gov: ${failures} of ${queries} searches failed, so the previous grant list was kept.`);
}

let syncing = false;

async function sync({ reason = 'manual', full = false } = {}) {
  if (syncing) return null;
  syncing = true;
  const started = Date.now();
  const errors = [];
  const runId = store.startRun(reason, full ? 'full' : 'incremental');
  hg.resetRun();
  let status = 'ok';
  try {
    // HigherGov work is sequential (opportunities, then contracts) so opportunities get first
    // claim on the record budget; the free sources run alongside it.
    const higherGov = (async () => {
      if (!config.apiKey) {
        errors.push('No HigherGov API key found (first line of ./key, or HG_API_KEY), so opportunities and contracts were not refreshed.');
        return;
      }
      await syncOpportunities(errors, full).catch((e) => errors.push(`Opportunities: ${hg.redact(e.message)}`));
      await syncContracts(errors, full);
    })();
    await Promise.all([
      higherGov,
      syncMarket(errors).catch((e) => errors.push(`USAspending: ${e.message}`)),
      syncGrants(errors).catch((e) => errors.push(`Grants.gov: ${e.message}`)),
      syncPursuitAwards(errors, full).catch((e) => errors.push(`USAspending (tracking list): ${e.message}`)),
    ]);
    if (errors.length) status = 'partial';
  } catch (error) {
    status = 'failed';
    errors.push(hg.redact(error.message));
  } finally {
    store.finishRun(runId, { status, records: hg.run.records, calls: hg.run.calls, errors });
    syncing = false;
  }
  return { status, errors, records: hg.run.records, calls: hg.run.calls, durationMs: Date.now() - started };
}

// ---------- Snapshot: SQLite -> browser ----------

function loadOpportunities(t) {
  const activeScopes = new Map(scopes().map((s) => [s.key, s]));
  const saved = store.savedKeys();
  const oldest = addDays(t, -config.lookbackDays);

  // HigherGov can hold several versions of one notice (amendments, forecast updates) under
  // different keys; keep the most recently captured version per source ID.
  const bySource = new Map();
  const stamp = (x) => x.capturedDate || x.postedDate || '';
  for (const o of store.allOpportunities()) {
    o.scopeKeys = o.scopeKeys.filter((k) => activeScopes.has(k));
    if (!o.scopeKeys.length) continue; // pulled for an agency or search that is no longer watched
    const key = store.sourceKeyOf(o);
    const existing = bySource.get(key);
    if (!existing) {
      bySource.set(key, o);
      continue;
    }
    const [keep, drop] = stamp(o) > stamp(existing) ? [o, existing] : [existing, o];
    keep.scopeKeys = [...new Set([...keep.scopeKeys, ...drop.scopeKeys])];
    keep.firstSeen = keep.firstSeen < drop.firstSeen ? keep.firstSeen : drop.firstSeen;
    bySource.set(key, keep);
  }

  const out = [];
  for (const [sourceKey, o] of bySource) {
    const status = opportunityStatus(o, t);
    const actionable = status === 'open' || status === 'forecast';
    if (!actionable && (!o.postedDate || o.postedDate < oldest)) continue;
    const body = `${o.summary}\n${o.description}`;
    const text = `${o.title}\n${body}`;
    const agencyScope = o.scopeKeys.map((k) => activeScopes.get(k)).find((s) => s.kind === 'agency');
    const lane = agencyScope?.label || o.agency?.abbr || o.agency?.name || 'Other';
    const { scopeKeys, ...rest } = o;
    const mentions = AGENCY_MENTIONS.filter((a) => a.label !== lane && a.patterns.some((re) => re.test(text))).map((a) => a.label);
    const cls = classify({ title: o.title, body, psc: o.psc, naics: o.naics });
    const tracked = pursuits.matchNotice({ lane, mentions }, `${text}\n${o.sourceId || ''}`);
    out.push({
      ...rest,
      sourceKey,
      description: o.description.length > 2400 ? `${o.description.slice(0, 2400)}…` : o.description,
      ...cls,
      // A notice for an effort on the tracking list is always of interest, whatever its topic score.
      relevant: cls.relevant || tracked.length > 0,
      pursuits: tracked,
      status,
      lane,
      mentions,
      viaSearch: scopeKeys.some((k) => activeScopes.get(k).kind === 'search'),
      value: o.valueHigh ?? o.valueLow ?? null,
      saved: saved.has(sourceKey),
    });
  }
  return out;
}

// The per-agency award list is not shown anywhere, so it is left out to keep the payload small.
function profileOf(agency) {
  const profile = store.getCache(`agency:${agency.key}`)?.value;
  if (!profile) return null;
  const { topAwards, ...rest } = profile;
  return rest;
}

const searched = (p) => Boolean(p.toptier && pursuits.awardTerms(p).length);

function loadPursuits(opportunities) {
  return pursuits.PURSUITS.map((p) => ({
    ...pursuits.publicFields(p),
    notices: opportunities.filter((o) => o.pursuits.includes(p.id)).map((o) => o.sourceKey),
    awards: (searched(p) && store.getCache(`pursuit:${p.id}`)?.value.awards) || [],
    awardsSearched: searched(p),
  }));
}

function loadAgencies(t) {
  return config.agencies.filter((a) => a.page).map((agency) => {
    const { fetchedOn, contracts } = store.contractsFor(agency.key);
    return {
      key: agency.key,
      label: agency.label,
      name: agency.name,
      role: agency.role,
      contractsFetchedOn: fetchedOn,
      contracts: contracts.map((c) => {
        const cls = classify({ title: c.description, body: c.relatedOpportunity || '', psc: c.psc, naics: c.naics });
        const end = c.potentialEndDate || c.currentEndDate;
        return { ...c, ...cls, agencyKey: agency.key, agencyLabel: agency.label, active: Boolean(end && end >= t) };
      }),
      profile: profileOf(agency),
    };
  });
}

function loadGrants(t) {
  return (store.getCache('grants')?.value || [])
    .map((g) => {
      const c = classify({ title: g.title });
      const themes = c.themes.length ? c.themes : g.queryThemes;
      return {
        ...g,
        themes,
        primaryTheme: themes[0],
        fit: c.fit,
        titleMatch: c.themes.length > 0,
        closingSoon: Boolean(g.closeDate && g.closeDate >= t && g.closeDate <= addDays(t, 30)),
      };
    })
    .filter((g) => !g.closeDate || g.closeDate >= t);
}

function buildSnapshot() {
  const t = today();
  const run = store.lastRun();
  const { window, currentFy, startFy } = marketWindow();
  const profiles = {};
  for (const theme of THEMES) {
    const cached = store.getCache(`market:${theme.id}`);
    if (cached) profiles[theme.id] = cached.value;
  }
  const opportunities = loadOpportunities(t);
  return {
    asOf: t,
    refreshedAt: run?.finished_at || null,
    empty: !run,
    errors: run?.errors || [],
    config: {
      timezone: config.timezone,
      lookbackDays: config.lookbackDays,
      agencies: config.agencies.map(({ key, label, name, role }) => ({ key, label, name, role })),
      savedSearches: config.savedSearches.map((s) => s.label),
      themes: THEMES.map(({ id, label, color }) => ({ id, label, color })),
      hasHigherGovKey: Boolean(config.apiKey),
      ai: { enabled: Boolean(config.openaiKey), model: config.openaiModel },
    },
    quota: {
      ...store.usage(t.slice(0, 7)),
      monthlyAllowance: config.monthlyAllowance,
      lastRunRecords: run?.hg_records ?? 0,
    },
    opportunities,
    pursuits: loadPursuits(opportunities),
    agencies: loadAgencies(t),
    market: { window, currentFy, startFy, profiles },
    grants: loadGrants(t),
  };
}

module.exports = { sync, buildSnapshot, syncPursuitAwards, isSyncing: () => syncing, redact: hg.redact };
