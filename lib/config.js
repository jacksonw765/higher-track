const fs = require('fs');
const path = require('path');
const focus = require('../focus.config');

const ROOT = path.join(__dirname, '..');

// ./key holds one key per line, in any order: the HigherGov key and (optionally) an OpenAI key.
// OpenAI keys are recognised by their "sk-" prefix, so one can never be sent to HigherGov.
function readKeys() {
  const keys = {
    higherGov: (process.env.HG_API_KEY || '').trim(),
    openai: (process.env.OPENAI_API_KEY || '').trim(),
  };
  let lines = [];
  try {
    lines = fs
      .readFileSync(process.env.HG_API_KEY_FILE || path.join(ROOT, 'key'), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.replace(/^[A-Za-z_ ]+[=:]\s*/, '').trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    /* no key file; environment variables only */
  }
  for (const line of lines) {
    if (line.startsWith('sk-')) keys.openai ||= line;
    else keys.higherGov ||= line;
  }
  return keys;
}

function int(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : fallback;
}

const keys = readKeys();

const agencies = (focus.agencies || []).map((a) => ({
  key: Number(a.key),
  label: a.label || `Agency ${a.key}`,
  name: a.name || a.label || `Agency ${a.key}`,
  aliases: a.aliases || [],
  usaspending: a.usaspending || null,
  role: a.role === 'awarding' ? 'awarding' : 'funding',
  // Watch-only agencies (page: false) are pulled for notices but get no profile or contract list.
  page: a.page !== false,
  contracts: a.page === false ? 0 : (a.contracts ?? 50),
  days: Number.isFinite(a.days) ? a.days : null,
}));

const savedSearches = (focus.savedSearches || []).map((s, i) =>
  typeof s === 'string' ? { id: s, label: `Saved search ${i + 1}` } : { id: String(s.id), label: s.label || `Saved search ${i + 1}` }
);

module.exports = {
  apiKey: keys.higherGov,
  openaiKey: keys.openai,
  openaiModel: process.env.OPENAI_MODEL || 'gpt-5.5',
  port: int('PORT', 4173),
  timezone: process.env.DASHBOARD_TZ || 'America/New_York',
  dbPath: process.env.DB_PATH || path.join(ROOT, 'data', 'opportunities.db'),
  // Data is refreshed on demand. Set AUTO_REFRESH_HOUR (0-23) to also refresh once a day.
  autoRefreshHour: int('AUTO_REFRESH_HOUR', null),

  agencies,
  savedSearches,
  lookbackDays: int('HG_LOOKBACK_DAYS', 120),
  searchLookbackDays: int('HG_SEARCH_LOOKBACK_DAYS', 30),
  refetchRecentDays: int('HG_REFETCH_RECENT_DAYS', 7),
  // Watch-only agencies re-pull fewer recent days, since they are many and mostly off-topic.
  watchRefetchDays: int('HG_WATCH_REFETCH_DAYS', 3),
  pursuitAwardRefreshDays: int('PURSUIT_AWARD_REFRESH_DAYS', 7),
  contractRefreshDays: int('HG_CONTRACT_REFRESH_DAYS', 7),
  recordBudgetPerRun: int('HG_RECORD_BUDGET', 1500),
  monthlyAllowance: int('HG_MONTHLY_ALLOWANCE', 10000),
  concurrency: int('HG_CONCURRENCY', 4),
  requestTimeoutMs: int('HG_TIMEOUT_MS', 45000),

  landscapeFiscalYears: int('LANDSCAPE_FY', 3),
  trendStartFiscalYear: int('TREND_START_FY', 2019),
};
