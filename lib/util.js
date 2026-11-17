const config = require('./config');

function ymdInZone(date, timeZone = config.timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function today() {
  return ymdInZone(new Date());
}

// Calendar-day arithmetic on YYYY-MM-DD strings, independent of the host timezone.
function addDays(ymd, days) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function lastNDays(n, end = today()) {
  return Array.from({ length: n }, (_, i) => addDays(end, -i));
}

function fiscalYearOf(ymd) {
  const [y, m] = ymd.split('-').map(Number);
  return m >= 10 ? y + 1 : y;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await tasks[i]() };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function fetchJson(url, { method = 'GET', body, timeoutMs = 45000, retries = 2, redact } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 200);
        throw new HttpError(res.status, `HTTP ${res.status}: ${text}`);
      }
      return await res.json();
    } catch (error) {
      lastError = error;
      const retryable = !(error instanceof HttpError) || error.status === 429 || error.status >= 500;
      if (!retryable || attempt === retries) break;
      await sleep(1000 * 2 ** attempt + Math.random() * 400);
    }
  }
  const message = String(lastError?.message || lastError);
  throw new Error(redact ? redact(message) : message);
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = { ymdInZone, today, addDays, lastNDays, fiscalYearOf, sleep, pool, fetchJson, num };
