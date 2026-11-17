// The tracking list (pursuits.config.js): named efforts the team is chasing. Each one is matched
// against stored notices and, where the work is publicly reported, against USAspending awards
// to surface the incumbent contract.

const { orgs: ORGS = {}, pursuits: RAW = [] } = require('../pursuits.config');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normId = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// Spaces in a phrase also match hyphens and line breaks ("Cyber Hygiene" ~ "cyber-hygiene").
const phraseRe = (s, flags) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(s.trim()).replace(/\s+/g, '[\\s-]+')}(?![A-Za-z0-9])`, flags);

const PURSUITS = RAW.map((p) => {
  const org = ORGS[p.org] || {};
  const keywords = p.keywords || [];
  const codes = p.codes || [];
  return {
    id: p.id || slug(`${p.agency} ${p.name}`),
    name: p.name,
    agency: p.agency,
    org: p.org,
    fullName: p.fullName || '',
    scope: p.scope || '',
    topics: p.topics || [],
    keywords,
    codes,
    incumbents: p.incumbents || [],
    value: p.value || '',
    timing: p.timing || '',
    ids: p.ids || [],
    notes: p.notes || '',
    followUps: p.followUps || [],
    priority: p.priority || null,
    confidence: p.confidence || 'none',
    sources: p.sources || [],
    // Not sent to the browser:
    lanes: new Set(p.lanes || org.lanes || []),
    awardIds: new Set((p.ids || []).map(normId)),
    toptier: p.awards === false ? null : org.usaspending || null,
    office: p.office ? new RegExp(escapeRe(p.office), 'i') : null,
    phraseRes: [...keywords, ...(p.ids || [])].map((k) => phraseRe(k, 'i')),
    // Code names are matched exactly as written, so "SOAR" does not fire on "soar".
    codeRes: codes.map((c) => phraseRe(c, '')),
  };
});

// A full phrase or solicitation number counts wherever it appears. A bare code name only counts
// in a notice from (or mentioning) one of the offices that buys for that organisation.
function matchNotice(o, text) {
  const hits = [];
  for (const p of PURSUITS) {
    if (p.phraseRes.some((re) => re.test(text))) hits.push(p.id);
    else if (p.codeRes.length && (p.lanes.has(o.lane) || o.mentions.some((m) => p.lanes.has(m))) && p.codeRes.some((re) => re.test(text))) hits.push(p.id);
  }
  return hits;
}

// USAspending descriptions are upper-case shorthand, so code names are compared case-insensitively
// there, and a code-only hit must also sit in the right office when one is configured.
function matchAward(p, award) {
  const text = award.description || '';
  if (p.awardIds.has(normId(award.awardId))) return true;
  if (p.phraseRes.some((re) => re.test(text))) return true;
  const offices = `${award.subAgency || ''} ${award.fundingSubAgency || ''}`;
  if (p.office && !p.office.test(offices)) return false;
  return p.codes.some((c) => phraseRe(c, 'i').test(text));
}

// Terms worth sending to USAspending's keyword search (it rejects anything under three characters).
const awardKeywords = (p) => [...new Set([...p.keywords, ...p.codes])].filter((k) => k.length >= 3).slice(0, 10);
// USAspending stores award numbers without punctuation.
const awardIdTerms = (p) => [...p.awardIds].filter((id) => id.length >= 8);
const awardTerms = (p) => [...awardKeywords(p), ...awardIdTerms(p)];

const publicFields = ({ lanes, toptier, office, phraseRes, codeRes, awardIds, ...rest }) => rest;

module.exports = { PURSUITS, ORGS, matchNotice, matchAward, awardKeywords, awardIdTerms, awardTerms, publicFields };
