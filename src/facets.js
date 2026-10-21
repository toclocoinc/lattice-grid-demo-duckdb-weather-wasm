/**
 * Header histograms for a grid that holds a window, not the data.
 *
 * A grid with every row in memory counts its own histogram buckets. This one
 * holds 200 of 8.7 million, so it asks for the counts through
 * `facets.provider`: the grid says which column and which filters (the
 * column's own filter left out, so a histogram shows what the rest would
 * leave), and the answer comes from DuckDB as one `GROUP BY` over the
 * whole matching set, through `source.aggregate()`.
 *
 * The engine returns exact counts per distinct value, which is at most a few
 * thousand groups for any column here, and the buckets are cut from those. The
 * unfiltered counts are asked once per column and kept: they are the faint
 * backdrop each histogram draws behind the filtered bars.
 */

const COUNT = [{ id: 'n', col: 'row_id', fn: 'count' }];

/** Which family of buckets each histogram column draws, and how many. */
const KINDS = {
  state: { kind: 'category' },
  date: { kind: 'date' },
  tmax_c: { kind: 'numeric', buckets: 18 },
  tmin_c: { kind: 'numeric', buckets: 18 },
  prcp_mm: { kind: 'numeric', buckets: 16, floor: 0, ceilingPercentile: 0.98 },
};

const asNumber = (v) => {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'bigint') return Number(v);
  return Number(v);
};

/**
 * @param {object} source the pushdown source the grid reads
 * @returns {(request: object) => Promise<object>} a `facets.provider`
 */
export function makeFacetProvider(source) {
  const everything = new Map();

  /** The exact distribution of one column: `[value, count]` pairs, nulls included. */
  async function distribution(colId, filters, quick) {
    const answer = await source.aggregate(
      { filters: filters ?? null, quick: quick || '', sort: [], range: null, groupBy: [colId] },
      COUNT,
    );
    return (answer.groups ?? [])
      .filter((g) => !g.grouping?.[0])
      .map((g) => [g.keys[0], Number(g.values.n)]);
  }

  /** Cut the unfiltered distribution into buckets, once. */
  function cut(colId, pairs, wanted) {
    const spec = KINDS[colId];
    const present = pairs.filter(([v]) => v != null);

    if (spec.kind === 'category') {
      const values = present.map(([v]) => String(v)).sort();
      const buckets = values.map((value) => ({ value }));
      return { kind: 'category', buckets, cardinality: values.length };
    }

    if (spec.kind === 'date') {
      const days = present.map(([v]) => asNumber(v)).sort((a, b) => a - b);
      const first = new Date(days[0]);
      const last = new Date(days[days.length - 1]);
      const buckets = [];
      for (let y = first.getUTCFullYear(), m = first.getUTCMonth(); y < last.getUTCFullYear() || (y === last.getUTCFullYear() && m <= last.getUTCMonth());) {
        const from = Date.UTC(y, m, 1);
        const to = Date.UTC(y, m + 1, 0);
        buckets.push({ from, to, label: new Date(from).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) });
        m += 1;
        if (m > 11) { m = 0; y += 1; }
      }
      return { kind: 'date', buckets, granularity: 'month', min: days[0], max: days[days.length - 1] };
    }

    const sorted = present.map(([v, n]) => [asNumber(v), n]).sort((a, b) => a[0] - b[0]);
    const total = sorted.reduce((sum, [, n]) => sum + n, 0);
    const lowest = sorted[0][0];
    const max = sorted[sorted.length - 1][0];
    /* The middle buckets span a percentile range, not the extremes, so a
       handful of freak readings cannot flatten the rest into one bar. The
       first and last buckets run out to the minimum and maximum and hold the
       tails. */
    const percentile = (p) => {
      let seen = 0;
      for (const [v, n] of sorted) {
        seen += n;
        if (seen / total >= p) return v;
      }
      return max;
    };
    const low = spec.floor ?? percentile(0.005);
    const high = percentile(spec.ceilingPercentile ?? 0.995);
    const middle = Math.max(2, (wanted || spec.buckets) - 2);
    const step = Math.max((high - low) / middle, 1e-9);
    const buckets = [];
    if (lowest < low) buckets.push({ from: lowest, to: low });
    for (let i = 0; i < middle; i += 1) buckets.push({ from: low + step * i, to: low + step * (i + 1) });
    if (max > low + step * middle) buckets.push({ from: low + step * middle, to: max });
    return { kind: 'numeric', buckets, min: lowest, max };
  }

  /** Count a distribution into the buckets of `bounds`. */
  function countInto(bounds, pairs) {
    const counts = new Uint32Array(bounds.buckets.length);
    const edges = bounds.buckets;
    const nullAt = edges.findIndex((b) => b.null);
    const ordered = bounds.kind === 'numeric' || bounds.kind === 'date';
    const byValue = ordered ? null : new Map(edges.map((b, i) => [b.value, i]));
    for (const [raw, n] of pairs) {
      if (raw == null) { if (nullAt >= 0) counts[nullAt] += n; continue; }
      if (!ordered) {
        const at = byValue.get(String(raw));
        if (at !== undefined) counts[at] += n;
        continue;
      }
      const v = asNumber(raw);
      let at = -1;
      for (let i = 0; i < edges.length; i += 1) {
        const b = edges[i];
        if (b.null) continue;
        const last = i === edges.length - 1 || edges[i + 1].null;
        const inside = bounds.kind === 'date'
          ? v >= b.from && v <= b.to
          : v >= b.from && (last ? v <= b.to : v < b.to);
        if (inside) { at = i; break; }
      }
      if (at < 0) at = v < edges[0].from ? 0 : edges.findLastIndex((b) => !b.null);
      counts[at] += n;
    }
    return counts;
  }

  return async function provider({ colId, filters, quick, bounds, buckets }) {
    if (!KINDS[colId]) return null;
    let base = everything.get(colId);
    if (!base) {
      base = distribution(colId, null, '');
      everything.set(colId, base);
    }
    const all = await base;
    const useBounds = bounds && bounds.buckets?.length ? bounds : cut(colId, all, buckets);
    const unfiltered = countInto(useBounds, all);
    const narrowed = filters || quick;
    const counts = narrowed ? countInto(useBounds, await distribution(colId, filters, quick)) : unfiltered;
    return { bounds: useBounds, counts, unfiltered };
  };
}
