// Scores notices against the topics defined in focus.config.js.

const { topics: THEMES } = require('../focus.config');

const IT_PSC = /^(D|7)/;
const IT_NAICS = /^5415(11|12|13|19)|^518210|^541715/;

const THEME_BY_ID = Object.fromEntries(THEMES.map((t) => [t.id, t]));

function matchTerms(text, terms) {
  const hits = [];
  let score = 0;
  if (!text) return { score, hits };
  for (const [patterns, weight, label] of terms) {
    const list = Array.isArray(patterns) ? patterns : [patterns];
    if (list.some((re) => re.test(text))) {
      score += weight;
      hits.push(label);
    }
  }
  return { score, hits };
}

// Title matches count double; description/summary matches count once; PSC/NAICS add a nudge.
// Boilerplate mentions ("comply with cybersecurity requirements") rarely clear the threshold alone.
function classify({ title = '', body = '', psc = '', naics = '' }) {
  const themeScores = THEMES.map((theme) => {
    const t = matchTerms(title, theme.terms);
    const b = matchTerms(body, theme.terms);
    let raw = t.score * 2 + b.score;
    if (psc && theme.psc.some((re) => re.test(psc))) raw += 3;
    if (naics && theme.naics.some((re) => re.test(naics))) raw += 2;
    return { id: theme.id, raw, hits: [...new Set([...t.hits, ...b.hits])] };
  });

  let itBoost = 0;
  if (psc && IT_PSC.test(psc)) itBoost += 2;
  if (naics && IT_NAICS.test(naics)) itBoost += 2;

  const ranked = themeScores.filter((s) => s.raw >= 3).sort((a, b) => b.raw - a.raw);
  const top = ranked[0];
  const total = themeScores.reduce((sum, s) => sum + s.raw, 0) + itBoost;
  const fit = Math.round(100 * (1 - Math.exp(-total / 12)));

  return {
    themes: ranked.map((s) => s.id),
    primaryTheme: top ? top.id : null,
    fit,
    relevant: Boolean(top) && fit >= 30,
    hits: ranked.flatMap((s) => s.hits).slice(0, 8),
    themeScores: Object.fromEntries(themeScores.map((s) => [s.id, s.raw])),
  };
}

module.exports = { THEMES, THEME_BY_ID, classify };
