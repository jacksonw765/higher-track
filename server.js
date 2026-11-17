const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const config = require('./lib/config');
const store = require('./lib/db');
const { sync, buildSnapshot, isSyncing } = require('./lib/collector');
const research = require('./lib/research');
const { today } = require('./lib/util');

const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const D3_PATH = path.join(__dirname, 'node_modules', 'd3', 'dist', 'd3.min.js');

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ---------- Snapshot (always built from SQLite) ----------

let snapshotBody = null; // gzipped JSON, rebuilt lazily after anything in the database changes
let dataVersion = 1; // bumped after each refresh so open browser tabs know to reload

function getSnapshotBody() {
  if (!snapshotBody) snapshotBody = zlib.gzipSync(JSON.stringify({ ...buildSnapshot(), dataVersion }));
  return snapshotBody;
}

async function refresh(reason, full = false) {
  if (isSyncing()) return;
  log(`Refresh started (${reason}${full ? ', full re-sync' : ''})`);
  const result = await sync({ reason, full });
  if (!result) return;
  snapshotBody = null;
  dataVersion++;
  log(
    `Refresh ${result.status} in ${(result.durationMs / 1000).toFixed(1)}s:`,
    `${result.records} HigherGov records / ${result.calls} calls, ${result.errors.length} warnings`
  );
  result.errors.forEach((e) => log('  warning:', e));
}

function statusPayload() {
  const run = store.lastRun();
  return {
    refreshing: isSyncing(),
    dataVersion,
    refreshedAt: run?.finished_at || null,
    lastStatus: run?.status || null,
  };
}

function scheduleDaily() {
  if (config.autoRefreshHour == null) return;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' })
      .formatToParts(new Date())
      .map((p) => [p.type, Number(p.value)])
  );
  let delta = config.autoRefreshHour * 3600 - (parts.hour * 3600 + parts.minute * 60 + parts.second);
  if (delta <= 0) delta += 86400;
  setTimeout(async () => {
    await refresh('daily schedule');
    scheduleDaily();
  }, delta * 1000);
}

// ---------- HTTP plumbing ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, SECURITY_HEADERS);
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
    });
    res.end(data);
  });
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('Request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Writes spend API quota and OpenAI credit, so they must come from this app's own pages: a
// cross-site form cannot send JSON, and a cross-site fetch carries a foreign Origin.
function isTrustedWrite(req) {
  if (!/^application\/json\b/.test(req.headers['content-type'] || '') && req.method !== 'DELETE') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// ---------- Routes ----------

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/snapshot') {
    const body = getSnapshotBody();
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS };
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' });
      return res.end(body);
    }
    res.writeHead(200, headers);
    return res.end(zlib.gunzipSync(body));
  }

  if (route === 'GET /api/status') return sendJson(res, 200, statusPayload());
  if (route === 'GET /api/research') return sendJson(res, 200, { enabled: research.enabled, model: config.openaiModel, items: store.listResearch() });

  const researchId = url.pathname.match(/^\/api\/research\/(\d+)$/);
  if (researchId && req.method === 'GET') {
    const row = store.getResearch(Number(researchId[1]));
    return row ? sendJson(res, 200, row) : sendJson(res, 404, { error: 'Report not found' });
  }

  if (req.method !== 'POST' && req.method !== 'DELETE') return sendJson(res, 404, { error: 'Not found' });
  if (!isTrustedWrite(req)) return sendJson(res, 403, { error: 'Request not allowed' });

  if (researchId && req.method === 'DELETE') {
    store.deleteResearch(Number(researchId[1]));
    return sendJson(res, 200, { ok: true });
  }

  const body = await readBody(req);

  if (route === 'POST /api/refresh') {
    if (!isSyncing()) refresh('manual', body.full === true);
    return sendJson(res, 202, { ...statusPayload(), refreshing: true });
  }

  if (route === 'POST /api/saved') {
    if (typeof body.sourceKey !== 'string' || !body.sourceKey) return sendJson(res, 400, { error: 'sourceKey is required' });
    store.setSaved(body.sourceKey.slice(0, 300), body.saved !== false);
    snapshotBody = null;
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'POST /api/quota') {
    const used = Number(body.used);
    if (!Number.isInteger(used) || used < 0 || used > 10_000_000) return sendJson(res, 400, { error: 'Enter a whole number of records.' });
    store.setReportedUsage(today().slice(0, 7), used);
    snapshotBody = null;
    return sendJson(res, 200, store.usage(today().slice(0, 7)));
  }

  if (route === 'POST /api/research') {
    try {
      const id = research.start(body);
      return sendJson(res, 202, store.getResearch(id));
    } catch (error) {
      if (error instanceof research.InputError) return sendJson(res, 400, { error: error.message });
      throw error;
    }
  }

  return sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url).catch((error) => {
      log('API error:', url.pathname, error.message);
      if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong on the server. Check the server log.' });
    });
  }

  if (url.pathname === '/vendor/d3.min.js') return sendFile(res, D3_PATH);
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });

  let rel;
  try {
    rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch {
    res.writeHead(400, SECURITY_HEADERS);
    return res.end('Bad request');
  }
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, SECURITY_HEADERS);
    return res.end('Forbidden');
  }
  sendFile(res, filePath);
});

server.listen(config.port, HOST, () => {
  const c = store.counts();
  log(`Dashboard on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${config.port}`);
  log(`Database ${config.dbPath}: ${c.opportunities} opportunities, ${c.contracts} contracts, ${c.research} research reports`);
  if (!config.apiKey) log('WARNING: no HigherGov API key found; only USAspending and Grants.gov data will load.');
  if (!config.openaiKey) log('NOTE: no OpenAI API key found; AI research is switched off.');
  if (!store.lastRun()) refresh('first run');
  else log('Serving stored data. Press Refresh in the dashboard to pull updates.');
  if (config.autoRefreshHour != null) log(`Daily refresh scheduled for ${config.autoRefreshHour}:00 ${config.timezone}`);
  scheduleDaily();
});
