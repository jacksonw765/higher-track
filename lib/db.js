const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS opportunities (
    id            TEXT PRIMARY KEY,
    source_key    TEXT NOT NULL,
    posted_date   TEXT,
    due_date      TEXT,
    captured_date TEXT,
    scopes        TEXT NOT NULL,          -- JSON array of the watch scopes that returned it
    data          TEXT NOT NULL,          -- JSON record as normalised from HigherGov
    first_seen    TEXT NOT NULL,
    last_seen     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS opportunities_posted ON opportunities (posted_date);

  -- One row per (scope, day) already pulled, so a refresh only asks HigherGov for what is missing.
  CREATE TABLE IF NOT EXISTS fetch_log (
    scope_key  TEXT NOT NULL,
    day        TEXT NOT NULL,
    records    INTEGER NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (scope_key, day)
  );

  CREATE TABLE IF NOT EXISTS contracts (
    agency_key INTEGER NOT NULL,
    award_id   TEXT NOT NULL,
    data       TEXT NOT NULL,
    fetched_on TEXT NOT NULL,
    PRIMARY KEY (agency_key, award_id)
  );

  -- Whole-document caches: USAspending profiles, Grants.gov results.
  CREATE TABLE IF NOT EXISTS cache (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS refresh_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    reason      TEXT,
    mode        TEXT,
    status      TEXT NOT NULL,
    hg_records  INTEGER NOT NULL DEFAULT 0,
    hg_calls    INTEGER NOT NULL DEFAULT 0,
    errors      TEXT
  );

  -- Every HigherGov response is tallied here as it arrives, so the count survives crashes and
  -- restarts. HigherGov bills per record returned, per calendar month.
  CREATE TABLE IF NOT EXISTS hg_usage (
    day     TEXT PRIMARY KEY,
    records INTEGER NOT NULL DEFAULT 0,
    calls   INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS saved (
    opp_source_key TEXT PRIMARY KEY,
    created_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS research (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,            -- opportunity | contract | company | question
    mode        TEXT NOT NULL,            -- analysis | contacts
    subject_id  TEXT,
    subject     TEXT NOT NULL,
    question    TEXT,
    status      TEXT NOT NULL,            -- running | done | error
    stage       TEXT,
    model       TEXT,
    result      TEXT,
    error       TEXT,
    created_at  TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS research_subject ON research (kind, subject_id);
`);

const now = () => new Date().toISOString();
const parse = (s, fallback = null) => {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

// ---------- Opportunities ----------
const selectOpp = db.prepare('SELECT scopes, captured_date, posted_date FROM opportunities WHERE id = ?');
const insertOpp = db.prepare(`
  INSERT INTO opportunities (id, source_key, posted_date, due_date, captured_date, scopes, data, first_seen, last_seen)
  VALUES (@id, @source_key, @posted_date, @due_date, @captured_date, @scopes, @data, @ts, @ts)`);
const updateOpp = db.prepare(`
  UPDATE opportunities SET source_key = @source_key, posted_date = @posted_date, due_date = @due_date,
    captured_date = @captured_date, scopes = @scopes, data = @data, last_seen = @ts WHERE id = @id`);
const logFetch = db.prepare(`
  INSERT INTO fetch_log (scope_key, day, records, fetched_at) VALUES (?, ?, ?, ?)
  ON CONFLICT (scope_key, day) DO UPDATE SET records = excluded.records, fetched_at = excluded.fetched_at`);

function sourceKeyOf(o) {
  return o.sourceId ? `${o.sourceType}:${o.sourceId.replace(/^\*/, '')}` : o.id;
}

// Stores one day's worth of notices for a scope and records that the day has been pulled.
const saveDay = db.transaction((scopeKey, day, rows) => {
  const ts = now();
  for (const o of rows) {
    const existing = selectOpp.get(o.id);
    const scopes = new Set(existing ? parse(existing.scopes, []) : []);
    scopes.add(scopeKey);
    const row = {
      id: o.id,
      source_key: sourceKeyOf(o),
      posted_date: o.postedDate,
      due_date: o.dueDate,
      captured_date: o.capturedDate,
      scopes: JSON.stringify([...scopes]),
      data: JSON.stringify(o),
      ts,
    };
    (existing ? updateOpp : insertOpp).run(row);
  }
  logFetch.run(scopeKey, day, rows.length, ts);
});

function fetchedDays(scopeKey) {
  return new Set(
    db
      .prepare('SELECT day FROM fetch_log WHERE scope_key = ?')
      .all(scopeKey)
      .map((r) => r.day)
  );
}

function allOpportunities() {
  return db
    .prepare('SELECT data, scopes, first_seen FROM opportunities')
    .all()
    .map((r) => ({ ...parse(r.data, {}), scopeKeys: parse(r.scopes, []), firstSeen: r.first_seen.slice(0, 10) }));
}

// ---------- Contracts ----------
const replaceContracts = db.transaction((agencyKey, contracts, fetchedOn) => {
  db.prepare('DELETE FROM contracts WHERE agency_key = ?').run(agencyKey);
  const insert = db.prepare('INSERT OR REPLACE INTO contracts (agency_key, award_id, data, fetched_on) VALUES (?, ?, ?, ?)');
  for (const c of contracts) insert.run(agencyKey, String(c.awardId), JSON.stringify(c), fetchedOn);
});

function contractsFor(agencyKey) {
  const rows = db.prepare('SELECT data, fetched_on FROM contracts WHERE agency_key = ?').all(agencyKey);
  return { fetchedOn: rows[0]?.fetched_on || null, contracts: rows.map((r) => parse(r.data, {})) };
}

// ---------- Document cache ----------
function setCache(key, value) {
  db.prepare(
    'INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).run(key, JSON.stringify(value), now());
}

function getCache(key) {
  const row = db.prepare('SELECT value, updated_at FROM cache WHERE key = ?').get(key);
  return row ? { value: parse(row.value), updatedAt: row.updated_at } : null;
}

// ---------- Refresh runs ----------
function startRun(reason, mode) {
  return db.prepare("INSERT INTO refresh_runs (started_at, reason, mode, status) VALUES (?, ?, ?, 'running')").run(now(), reason, mode)
    .lastInsertRowid;
}

function finishRun(id, { status, records, calls, errors }) {
  db.prepare('UPDATE refresh_runs SET finished_at = ?, status = ?, hg_records = ?, hg_calls = ?, errors = ? WHERE id = ?').run(
    now(),
    status,
    records,
    calls,
    JSON.stringify(errors || []),
    id
  );
}

function lastRun() {
  const row = db.prepare("SELECT * FROM refresh_runs WHERE status != 'running' ORDER BY id DESC LIMIT 1").get();
  return row ? { ...row, errors: parse(row.errors, []) } : null;
}

// ---------- HigherGov usage ----------
function addUsage(day, records) {
  db.prepare(
    'INSERT INTO hg_usage (day, records, calls) VALUES (?, ?, 1) ON CONFLICT (day) DO UPDATE SET records = records + excluded.records, calls = calls + 1'
  ).run(day, records);
}

// HigherGov's API does not report usage, so this app can only count its own calls. The account
// page on highergov.com is the authority; when the user types that figure in, the difference is
// kept as an offset for the month so the two stay in step from then on.
function usage(month) {
  const counted = db.prepare('SELECT COALESCE(SUM(records), 0) AS n FROM hg_usage WHERE substr(day, 1, 7) = ?').get(month).n;
  const correction = getCache(`quota:${month}`)?.value || null;
  return {
    month,
    counted,
    used: Math.max(0, counted + (correction?.offset || 0)),
    correctedAt: correction?.at || null,
  };
}

function setReportedUsage(month, reported) {
  const { counted } = usage(month);
  setCache(`quota:${month}`, { offset: reported - counted, at: now() });
}

// A server that died mid-refresh leaves a 'running' row behind; close those out on startup.
db.prepare("UPDATE refresh_runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'").run(now());

// ---------- Saved opportunities ----------
function savedKeys() {
  return new Set(
    db
      .prepare('SELECT opp_source_key FROM saved')
      .all()
      .map((r) => r.opp_source_key)
  );
}

function setSaved(sourceKey, saved) {
  if (saved) db.prepare('INSERT OR IGNORE INTO saved (opp_source_key, created_at) VALUES (?, ?)').run(sourceKey, now());
  else db.prepare('DELETE FROM saved WHERE opp_source_key = ?').run(sourceKey);
}

// ---------- Research ----------
const researchRow = (r, withResult) =>
  r && {
    id: r.id,
    kind: r.kind,
    mode: r.mode,
    subjectId: r.subject_id,
    subject: r.subject,
    question: r.question,
    status: r.status,
    stage: r.stage,
    model: r.model,
    error: r.error,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    ...(withResult ? { result: parse(r.result) } : {}),
  };

function createResearch({ kind, mode, subjectId, subject, question, model }) {
  const id = db
    .prepare(
      "INSERT INTO research (kind, mode, subject_id, subject, question, status, stage, model, created_at) VALUES (?, ?, ?, ?, ?, 'running', 'Gathering records', ?, ?)"
    )
    .run(kind, mode, subjectId || null, subject, question || null, model, now()).lastInsertRowid;
  return Number(id);
}

function updateResearch(id, fields) {
  const cols = { stage: 'stage', status: 'status', error: 'error', result: 'result', finishedAt: 'finished_at' };
  const sets = [];
  const values = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!cols[k]) continue;
    sets.push(`${cols[k]} = ?`);
    values.push(k === 'result' ? JSON.stringify(v) : v);
  }
  if (sets.length) db.prepare(`UPDATE research SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
}

function getResearch(id) {
  return researchRow(db.prepare('SELECT * FROM research WHERE id = ?').get(id), true);
}

function listResearch(limit = 100) {
  return db
    .prepare('SELECT * FROM research ORDER BY id DESC LIMIT ?')
    .all(limit)
    .map((r) => researchRow(r, false));
}

function deleteResearch(id) {
  db.prepare('DELETE FROM research WHERE id = ?').run(id);
}

// Anything still 'running' belonged to a previous process and will never finish.
db.prepare("UPDATE research SET status = 'error', error = 'Interrupted by a server restart', finished_at = ? WHERE status = 'running'").run(now());

function counts() {
  const n = (sql) => db.prepare(sql).get().n;
  return {
    opportunities: n('SELECT COUNT(*) AS n FROM opportunities'),
    contracts: n('SELECT COUNT(*) AS n FROM contracts'),
    daysFetched: n('SELECT COUNT(*) AS n FROM fetch_log'),
    research: n('SELECT COUNT(*) AS n FROM research'),
  };
}

module.exports = {
  db,
  sourceKeyOf,
  saveDay,
  fetchedDays,
  allOpportunities,
  replaceContracts,
  contractsFor,
  setCache,
  getCache,
  startRun,
  finishRun,
  lastRun,
  addUsage,
  usage,
  setReportedUsage,
  savedKeys,
  setSaved,
  createResearch,
  updateResearch,
  getResearch,
  listResearch,
  deleteResearch,
  counts,
};
