const { fetchJson } = require('./util');

const SEARCH_URL = 'https://api.grants.gov/v1/api/search2';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
function decodeEntities(s) {
  return (s || '').replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e) => ENTITIES[e]);
}

function toYmd(mdy) {
  if (!mdy) return null;
  const [m, d, y] = mdy.split('/');
  return y && m && d ? `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}` : null;
}

async function searchGrants(keyword) {
  const data = await fetchJson(SEARCH_URL, {
    method: 'POST',
    body: { keyword, oppStatuses: 'forecasted|posted', rows: 100 },
    timeoutMs: 60000,
  });
  if (data.errorcode && data.errorcode !== 0) throw new Error(`Grants.gov error ${data.errorcode}: ${data.msg}`);
  return data.data?.oppHits || [];
}

async function fetchGrants(keywords) {
  const settled = await Promise.allSettled(keywords.map(searchGrants));
  const byId = new Map();
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue;
    for (const g of r.value) {
      if (byId.has(g.id)) continue;
      byId.set(g.id, {
        id: g.id,
        number: g.number,
        title: decodeEntities(g.title),
        agency: decodeEntities(g.agency || g.agencyCode),
        agencyCode: g.agencyCode,
        status: g.oppStatus,
        openDate: toYmd(g.openDate),
        closeDate: toYmd(g.closeDate),
        cfda: (g.cfdaList || []).join(', '),
        url: `https://www.grants.gov/search-results-detail/${g.id}`,
      });
    }
  }
  const errors = settled.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message || r.reason));
  return { grants: [...byId.values()], errors };
}

module.exports = { fetchGrants };
