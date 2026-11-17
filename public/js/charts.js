/* global d3 */
import { state, OTHER, h, tip, money, int, signedPct, truncate, titleCase, shortDesc, parseDate, fmtDate, fmtShort, daysUntil, themeColor, themeLabel, fy } from './util.js';

export const BLUE = '#3f6fd8';
export const GREY = '#a3a39b';

// Marks ease in when a chart is drawn. Skipped for people who ask their system for less motion.
const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const enter = (sel, i = () => 0) =>
  still
    ? sel
    : sel
        .transition()
        .duration(650)
        .delay((d, n) => Math.min(i(d, n) * 22, 330))
        .ease(d3.easeCubicOut);

function frame(el, height, margin) {
  el.replaceChildren();
  const width = Math.max(300, el.clientWidth);
  const svg = d3.select(el).append('svg').attr('width', width).attr('height', height);
  const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
  return { svg, g, w: width - margin.left - margin.right, h: height - margin.top - margin.bottom };
}

export function empty(el, msg = 'Nothing to show yet') {
  el.replaceChildren(h('div', { class: 'empty' }, msg));
}

export function legend(el, items) {
  el.replaceChildren(...items.map((i) => h('span', null, h('i', { style: `background:${i.color}` }), i.label)));
}

// Horizontal ranked bars. Rows are clickable when onClick is given.
export function hbar(el, data, { format = money, color = () => BLUE, onClick, tooltip, max = 12 } = {}) {
  data = data.filter((d) => d.value > 0).slice(0, max);
  if (!data.length) return empty(el);
  const rowH = 26;
  const lw = Math.min(280, Math.max(120, el.clientWidth * 0.44));
  const right = 86;
  const { g, w } = frame(el, data.length * rowH + 4, { top: 2, right, bottom: 2, left: lw });
  const x = d3.scaleLinear().domain([0, d3.max(data, (d) => d.value)]).range([0, w]);
  const y = d3.scaleBand().domain(d3.range(data.length)).range([0, data.length * rowH]).padding(0.3);
  const row = g
    .selectAll('g')
    .data(data)
    .join('g')
    .attr('class', onClick ? 'clickable' : null)
    .attr('transform', (_, i) => `translate(0,${y(i)})`);
  row.append('rect').attr('x', -lw).attr('width', lw + w + right).attr('y', -3).attr('height', y.bandwidth() + 6).attr('fill', 'transparent');
  row
    .append('text')
    .attr('class', 'label')
    .attr('x', -10)
    .attr('y', y.bandwidth() / 2)
    .attr('dy', '0.35em')
    .attr('text-anchor', 'end')
    .text((d) => truncate(d.label, Math.floor(lw / 6.7)));
  enter(row.append('rect').attr('height', y.bandwidth()).attr('rx', 2).attr('fill', (d, i) => color(d, i)).attr('width', 0), (_, n) => n).attr('width', (d) => Math.max(2, x(d.value)));
  enter(
    row
      .append('text')
      .attr('class', 'value')
      .attr('x', 6)
      .attr('y', y.bandwidth() / 2)
      .attr('dy', '0.35em')
      .attr('opacity', 0)
      .text((d) => format(d.value, d)),
    (_, n) => n
  )
    .attr('x', (d) => Math.max(2, x(d.value)) + 6)
    .attr('opacity', 1);
  row
    .on('mousemove', (event, d) => tip.show(event, d.label, tooltip ? tooltip(d) : [['Value', format(d.value, d)]]))
    .on('mouseleave', tip.hide)
    .on('click', (_, d) => onClick && onClick(d));
}

// Vertical bars, one per fiscal year. The current (partial) year is drawn lighter.
export function fyBars(el, data, currentFy) {
  if (!data.length) return empty(el, 'No USAspending data for this agency');
  const { g, w, h: ht } = frame(el, 250, { top: 22, right: 6, bottom: 24, left: 50 });
  const x = d3.scaleBand().domain(data.map((d) => d.fy)).range([0, w]).padding(0.3);
  const y = d3.scaleLinear().domain([0, d3.max(data, (d) => d.amount)]).nice().range([ht, 0]);
  g.append('g').attr('class', 'grid-lines').call(d3.axisLeft(y).ticks(4).tickSize(-w).tickFormat(''));
  g.append('g').attr('class', 'axis').call(d3.axisLeft(y).ticks(4).tickFormat(money).tickSize(0).tickPadding(8)).select('.domain').remove();
  g.append('g')
    .attr('class', 'axis')
    .attr('transform', `translate(0,${ht})`)
    .call(d3.axisBottom(x).tickFormat(fy).tickSize(0).tickPadding(8));
  g.selectAll('rect.bar')
    .data(data)
    .join('rect')
    .attr('class', 'bar')
    .attr('x', (d) => x(d.fy))
    .attr('width', x.bandwidth())
    .attr('y', (d) => y(d.amount))
    .attr('height', (d) => ht - y(d.amount))
    .attr('rx', 2)
    .attr('fill', BLUE)
    .attr('fill-opacity', (d) => (d.fy === currentFy ? 0.35 : 1))
    .on('mousemove', (event, d) => {
      const prev = data.find((p) => p.fy === d.fy - 1);
      tip.show(event, `FY${d.fy}${d.fy === currentFy ? ' (year to date)' : ''}`, [
        ['Obligations', money(d.amount)],
        prev && prev.amount && d.fy !== currentFy ? ['Change', signedPct(d.amount / prev.amount - 1)] : null,
      ]);
    })
    .on('mouseleave', tip.hide);
  enter(g.selectAll('rect.bar').attr('y', ht).attr('height', 0), (_, n) => n)
    .attr('y', (d) => y(d.amount))
    .attr('height', (d) => ht - y(d.amount));
  enter(
    g
      .selectAll('text.v')
      .data(data)
      .join('text')
      .attr('class', 'value')
      .attr('x', (d) => x(d.fy) + x.bandwidth() / 2)
      .attr('y', ht - 5)
      .attr('opacity', 0)
      .attr('text-anchor', 'middle')
      .text((d) => money(d.amount)),
    (_, n) => n
  )
    .attr('y', (d) => y(d.amount) - 5)
    .attr('opacity', 1);
}

// Stacked weekly counts of posted notices by primary focus area.
export function weeklyFlow(el, opps) {
  const start = d3.utcMonday.floor(d3.utcDay.offset(state.today, -state.snap.config.lookbackDays + 1));
  const weeks = d3.utcMonday.range(start, d3.utcDay.offset(state.today, 1));
  const keys = [...state.themes.map((t) => t.id), 'other'];
  const rows = weeks.map((w) => Object.fromEntries([['week', w], ...keys.map((k) => [k, 0])]));
  const idx = new Map(rows.map((r, i) => [+r.week, i]));
  for (const o of opps) {
    if (!o.postedDate || o.status === 'forecast') continue;
    const i = idx.get(+d3.utcMonday.floor(parseDate(o.postedDate)));
    if (i != null) rows[i][o.relevant && o.primaryTheme ? o.primaryTheme : 'other']++;
  }
  if (!rows.some((r) => keys.some((k) => r[k]))) return empty(el, 'No notices posted in the look-back window');
  const { g, w, h: ht } = frame(el, 220, { top: 8, right: 6, bottom: 24, left: 30 });
  const x = d3.scaleBand().domain(weeks).range([0, w]).padding(0.22);
  const y = d3.scaleLinear().domain([0, d3.max(rows, (r) => d3.sum(keys, (k) => r[k])) || 1]).nice().range([ht, 0]);
  g.append('g').attr('class', 'grid-lines').call(d3.axisLeft(y).ticks(4).tickSize(-w).tickFormat(''));
  g.append('g').attr('class', 'axis').call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(8)).select('.domain').remove();
  g.append('g')
    .attr('class', 'axis')
    .attr('transform', `translate(0,${ht})`)
    .call(
      d3
        .axisBottom(x)
        .tickValues(weeks.filter((_, i) => i % Math.ceil(weeks.length / 9) === 0))
        .tickFormat(fmtShort)
        .tickSize(0)
        .tickPadding(8)
    );
  g.selectAll('g.layer')
    .data(d3.stack().keys(keys)(rows))
    .join('g')
    .attr('class', 'layer')
    .style('fill', (d) => (d.key === 'other' ? OTHER.color : themeColor(d.key)))
    .selectAll('rect')
    .data((d) => d.map((v) => Object.assign(v, { key: d.key })))
    .join('rect')
    .attr('x', (d) => x(d.data.week))
    .attr('width', x.bandwidth())
    .attr('y', (d) => y(d[1]))
    .attr('height', (d) => Math.max(0, y(d[0]) - y(d[1])))
    .on('mousemove', (event, d) =>
      tip.show(event, `Week of ${fmtDate(d.data.week)}`, [
        ...keys.filter((k) => d.data[k]).map((k) => [k === 'other' ? 'Outside focus areas' : themeLabel(k), int(d.data[k])]),
        ['Total', int(d3.sum(keys, (k) => d.data[k]))],
      ])
    )
    .on('mouseleave', tip.hide);
  const bars = g.selectAll('g.layer rect');
  enter(bars.attr('y', ht).attr('height', 0), (d) => idx.get(+d.data.week) * 0.6)
    .attr('y', (d) => y(d[1]))
    .attr('height', (d) => Math.max(0, y(d[0]) - y(d[1])));
}

// One line per series across fiscal years, labelled at the right-hand end.
export function trendLines(el, series) {
  const all = series.flatMap((s) => s.values);
  if (!all.length) return empty(el, 'No USAspending data yet');
  const { g, w, h: ht } = frame(el, 280, { top: 10, right: 150, bottom: 24, left: 50 });
  const x = d3.scalePoint().domain([...new Set(all.map((d) => d.fy))].sort()).range([0, w]).padding(0.2);
  const y = d3.scaleLinear().domain([0, d3.max(all, (d) => d.amount)]).nice().range([ht, 0]);
  g.append('g').attr('class', 'grid-lines').call(d3.axisLeft(y).ticks(5).tickSize(-w).tickFormat(''));
  g.append('g').attr('class', 'axis').call(d3.axisLeft(y).ticks(5).tickFormat(money).tickSize(0).tickPadding(8)).select('.domain').remove();
  g.append('g').attr('class', 'axis').attr('transform', `translate(0,${ht})`).call(d3.axisBottom(x).tickFormat(fy).tickSize(0).tickPadding(8));
  const line = d3.line().x((d) => x(d.fy)).y((d) => y(d.amount));
  const sg = g.selectAll('g.series').data(series).join('g').attr('class', 'series');
  const paths = sg.append('path').attr('fill', 'none').attr('stroke', (s) => s.color).attr('stroke-width', 2).attr('d', (s) => line(s.values));
  if (!still) {
    // Draw each line left to right by revealing its dash.
    paths
      .attr('stroke-dasharray', function () {
        return this.getTotalLength();
      })
      .attr('stroke-dashoffset', function () {
        return this.getTotalLength();
      })
      .transition()
      .duration(900)
      .ease(d3.easeCubicOut)
      .attr('stroke-dashoffset', 0)
      .on('end', function () {
        d3.select(this).attr('stroke-dasharray', null);
      });
  }
  sg.selectAll('circle')
    .data((s) => s.values.map((v, i) => ({ ...v, s, prev: s.values[i - 1] })))
    .join('circle')
    .attr('cx', (d) => x(d.fy))
    .attr('cy', (d) => y(d.amount))
    .attr('r', 3.5)
    .style('fill', 'var(--surface)')
    .attr('stroke', (d) => d.s.color)
    .attr('stroke-width', 2)
    .on('mousemove', (event, d) =>
      tip.show(event, `${d.s.label} · FY${d.fy}`, [['Obligations', money(d.amount)], d.prev && d.prev.amount ? ['Change', signedPct(d.amount / d.prev.amount - 1)] : null])
    )
    .on('mouseleave', tip.hide);
  const ends = series
    .filter((s) => s.values.length)
    .map((s) => ({ s, y: y(s.values[s.values.length - 1].amount), x: x(s.values[s.values.length - 1].fy) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 15);
  g.selectAll('text.end')
    .data(ends)
    .join('text')
    .attr('x', (d) => d.x + 10)
    .attr('y', (d) => d.y)
    .attr('dy', '0.35em')
    .style('fill', (d) => d.s.color)
    .style('font-weight', 600)
    .text((d) => truncate(d.s.label, 24));
}

// Period-of-performance bars for active contracts, soonest ending first.
export function timeline(el, contracts, onClick) {
  const list = contracts
    .filter((c) => c.active && c.startDate && c.potentialEndDate)
    .sort((a, b) => (b.potentialValue || 0) - (a.potentialValue || 0))
    .slice(0, 18)
    .sort((a, b) => d3.ascending(a.potentialEndDate, b.potentialEndDate));
  if (!list.length) return empty(el, 'No active contracts in the tracked set');
  const rowH = 26;
  const lw = Math.min(320, Math.max(150, el.clientWidth * 0.34));
  const { g, w, h: ht } = frame(el, list.length * rowH + 30, { top: 4, right: 70, bottom: 24, left: lw });
  const lo = d3.max([d3.min(list, (c) => parseDate(c.startDate)), d3.utcYear.offset(state.today, -5)]);
  const hi = d3.min([d3.max(list, (c) => parseDate(c.potentialEndDate)), d3.utcYear.offset(state.today, 8)]);
  const x = d3.scaleUtc().domain([lo, hi]).range([0, w]);
  const y = d3.scaleBand().domain(d3.range(list.length)).range([0, list.length * rowH]).padding(0.34);
  const clampX = (d) => x(d3.max([lo, d3.min([hi, d])]));
  const color = (c) => {
    const months = daysUntil(c.potentialEndDate) / 30.4;
    return months <= 12 ? '#c2410c' : months <= 24 ? '#d4a017' : BLUE;
  };
  g.append('g').attr('class', 'grid-lines').attr('transform', `translate(0,${ht})`).call(d3.axisBottom(x).ticks(7).tickSize(-ht).tickFormat(''));
  g.append('g').attr('class', 'axis').attr('transform', `translate(0,${ht})`).call(d3.axisBottom(x).ticks(7).tickSize(0).tickPadding(8));
  const row = g
    .selectAll('g.row')
    .data(list)
    .join('g')
    .attr('class', 'row clickable')
    .attr('transform', (_, i) => `translate(0,${y(i)})`)
    .on('mousemove', (event, c) =>
      tip.show(event, `${c.awardeeParent || c.awardee} · ${shortDesc(c.description, 70)}`, [
        ['Potential value', money(c.potentialValue)],
        ['Started', fmtDate(parseDate(c.startDate))],
        ['Current end', c.currentEndDate ? fmtDate(parseDate(c.currentEndDate)) : '—'],
        ['Potential end', `${fmtDate(parseDate(c.potentialEndDate))} (${Math.round(daysUntil(c.potentialEndDate) / 30.4)} mo)`],
      ])
    )
    .on('mouseleave', tip.hide)
    .on('click', (_, c) => onClick(c));
  row.append('rect').attr('x', -lw).attr('width', lw + w + 70).attr('y', -4).attr('height', y.bandwidth() + 8).attr('fill', 'transparent');
  row
    .append('text')
    .attr('class', 'label')
    .attr('x', -10)
    .attr('y', y.bandwidth() / 2)
    .attr('dy', '0.35em')
    .attr('text-anchor', 'end')
    .text((c) => truncate(`${c.awardeeParent || c.awardee} · ${shortDesc(c.description)}`, Math.floor(lw / 6.5)));
  row
    .append('rect')
    .attr('class', 'span')
    .attr('x', (c) => clampX(parseDate(c.startDate)))
    .attr('width', 0)
    .attr('height', y.bandwidth())
    .attr('rx', 2)
    .attr('fill', color);
  enter(row.select('rect.span'), (_, n) => n).attr('width', (c) => Math.max(3, clampX(parseDate(c.potentialEndDate)) - clampX(parseDate(c.startDate))));
  row
    .filter((c) => c.currentEndDate && c.currentEndDate !== c.potentialEndDate && parseDate(c.currentEndDate) > lo && parseDate(c.currentEndDate) < hi)
    .append('line')
    .attr('x1', (c) => x(parseDate(c.currentEndDate)))
    .attr('x2', (c) => x(parseDate(c.currentEndDate)))
    .attr('y1', -3)
    .attr('y2', y.bandwidth() + 3)
    .style('stroke', 'var(--text)')
    .attr('stroke-width', 1.5);
  row
    .append('text')
    .attr('class', 'value')
    .attr('x', (c) => clampX(parseDate(c.potentialEndDate)) + 6)
    .attr('y', y.bandwidth() / 2)
    .attr('dy', '0.35em')
    .text((c) => money(c.potentialValue));
  g.append('line').attr('class', 'today-line').attr('x1', x(state.today)).attr('x2', x(state.today)).attr('y1', -2).attr('y2', ht);
}
