/**
 * The dashboard.
 *
 * One idea runs through the page: the browser holds a window of rows, and every
 * figure on screen is computed by DuckDB over the whole matching set.
 *
 *   the table      a window of 200 rows, fetched per interaction, with the
 *                  match count riding along in the same statement.
 *   the grouping   group rows, their counts and their averages are one
 *                  GROUP BY per level, pushed to the engine.
 *   the headers    each column's histogram is a bucketed count over every
 *                  matching row, from the engine.
 *   the chart      bound to the grid: its x and measures become the GROUP BY.
 *   the calendar   one station's year, fetched by a query of its own.
 *
 * Nothing on screen is reduced from the 200 rows the grid holds.
 */

import {
  CALENDAR_STATIONS, COLUMNS, GRID_FIELDS, HOT_C, PRESETS, WET_MM, fmt, num,
} from './weather.js';
import { readRangeAccounting } from './duckdb.js';
import { useLocal } from './config.js';
import { makeFacetProvider } from './facets.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const GROUPINGS = [
  { id: '', label: 'No grouping', by: [] },
  { id: 'state', label: 'By state', by: ['state'] },
  { id: 'month', label: 'By month', by: ['month'] },
  { id: 'state-month', label: 'By state, then month', by: ['state', 'month'] },
];

export function buildDashboard({
  root, LG, createChart, connection, recordSql, sqlLog, duckdbVersion, facts, dataUrl,
}) {
  const FILE = dataUrl;

  const built = {
    ready: false,
    grid: null,
    source: null,
    adapter: null,
    chart: null,
    calendar: null,
    calendarGrid: null,
    calendarStation: null,
    matchCount: null,
    totalRows: facts?.rows ?? null,
    plan: null,
    lastBurst: null,
    filters: { state: '', from: '', to: '', preset: '' },
    duckdbVersion,
  };

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  root.textContent = '';
  root.className = 'app';

  const header = el('header', 'masthead');
  const titleRow = el('div', 'title-row');
  titleRow.append(el('h1', null, `${facts ? (facts.rows / 1e6).toFixed(1) : 'Millions of'} million days of US weather, all in your browser`.replace(/^Millions of million/, 'Millions of')));
  const themeButton = el('button', 'theme-toggle', 'Dark mode');
  themeButton.type = 'button';
  themeButton.setAttribute('aria-pressed', 'false');
  titleRow.append(themeButton);
  header.append(titleRow);
  header.append(el('p', 'lede',
    'Every daily reading from every US weather station in 2025 sits in one Parquet file. DuckDB, compiled to '
    + 'WebAssembly, reads only the pieces of it a question needs, and Lattice Grid turns each filter, sort, '
    + 'group and chart into SQL. There is no backend: the only requests the data ever makes are byte-range reads of that file.'));
  const liveLine = el('p', 'live');
  liveLine.dataset.live = '';
  liveLine.setAttribute('aria-live', 'polite');
  header.append(liveLine);
  root.append(header);

  const controls = el('section', 'controls');
  controls.setAttribute('aria-label', 'Filters and grouping');
  root.append(controls);

  const gridHost = el('section', 'grid-host');
  gridHost.setAttribute('aria-label', 'Station-days');
  root.append(gridHost);

  const chartRow = el('section', 'charts');
  chartRow.setAttribute('aria-label', 'Charts');
  root.append(chartRow);

  const sqlSection = el('section', 'sql-panel');
  sqlSection.setAttribute('aria-label', 'What went to DuckDB');
  root.append(sqlSection);

  const footer = el('footer', 'colophon');
  root.append(footer);

  /* ------------------------------------------------------------------ */
  /* Theme                                                               */
  /* ------------------------------------------------------------------ */

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const applyTheme = (dark) => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    themeButton.textContent = dark ? 'Light mode' : 'Dark mode';
    themeButton.setAttribute('aria-pressed', String(dark));
  };
  applyTheme(media.matches);
  themeButton.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme !== 'dark'));

  /* ------------------------------------------------------------------ */
  /* Controls                                                            */
  /* ------------------------------------------------------------------ */

  const field = (labelText, input) => {
    const wrap = el('label', 'field');
    wrap.append(el('span', 'field-label', labelText), input);
    return wrap;
  };

  const stateSelect = el('select', 'input');
  stateSelect.dataset.control = 'state';
  stateSelect.append(new Option('All states', ''));
  const fromInput = el('input', 'input');
  fromInput.type = 'date';
  fromInput.min = '2025-01-01';
  fromInput.max = '2025-12-31';
  fromInput.dataset.control = 'from';
  const toInput = el('input', 'input');
  toInput.type = 'date';
  toInput.min = '2025-01-01';
  toInput.max = '2025-12-31';
  toInput.dataset.control = 'to';
  const groupSelect = el('select', 'input');
  groupSelect.dataset.control = 'group';
  for (const g of GROUPINGS) groupSelect.append(new Option(g.label, g.id));

  const filterRow = el('div', 'control-row');
  filterRow.append(
    field('State', stateSelect),
    field('From', fromInput),
    field('To', toInput),
    field('Group', groupSelect),
  );

  const chipRow = el('div', 'chips');
  chipRow.append(el('span', 'chips-label', 'Quick filters:'));
  const chipButtons = new Map();
  for (const preset of PRESETS) {
    const button = el('button', 'chip', preset.label);
    button.type = 'button';
    button.dataset.preset = preset.id;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      built.filters.preset = built.filters.preset === preset.id ? '' : preset.id;
      applyFilters();
    });
    chipButtons.set(preset.id, button);
    chipRow.append(button);
  }
  const clearButton = el('button', 'chip-clear', 'Clear filters');
  clearButton.type = 'button';
  clearButton.dataset.control = 'clear';
  clearButton.addEventListener('click', () => {
    built.filters = { state: '', from: '', to: '', preset: '' };
    stateSelect.value = '';
    fromInput.value = '';
    toInput.value = '';
    applyFilters();
  });
  chipRow.append(clearButton);
  controls.append(filterRow, chipRow);

  /** The filter tree the controls stand for, as the grid takes it. */
  function filterTree() {
    const conditions = [];
    const f = built.filters;
    if (f.state) conditions.push({ col: 'state', op: 'eq', value: f.state });
    if (f.from) conditions.push({ col: 'date', op: 'gte', value: `${f.from}T00:00:00.000Z` });
    if (f.to) conditions.push({ col: 'date', op: 'lte', value: `${f.to}T00:00:00.000Z` });
    const preset = PRESETS.find((p) => p.id === f.preset);
    if (preset) conditions.push(preset.tree);
    if (!conditions.length) return null;
    return conditions.length === 1 ? conditions[0] : { op: 'and', conditions };
  }

  function applyFilters() {
    const f = built.filters;
    for (const [id, button] of chipButtons) {
      button.classList.toggle('on', f.preset === id);
      button.setAttribute('aria-pressed', String(f.preset === id));
    }
    built.grid?.filters.set(filterTree());
  }

  stateSelect.addEventListener('change', () => { built.filters.state = stateSelect.value; applyFilters(); });
  fromInput.addEventListener('change', () => { built.filters.from = fromInput.value; applyFilters(); });
  toInput.addEventListener('change', () => { built.filters.to = toInput.value; applyFilters(); });
  groupSelect.addEventListener('change', () => {
    const choice = GROUPINGS.find((g) => g.id === groupSelect.value) ?? GROUPINGS[0];
    built.grid?.columns.group(choice.by);
  });

  /* ------------------------------------------------------------------ */
  /* Live timings                                                        */
  /* ------------------------------------------------------------------ */

  /*
   * A "burst" is the statements one interaction sets off: they finish within a
   * short gap of each other. Its wall time is the figure shown, because that is
   * what the reader waited for; the statement count says how much was asked.
   */
  const burst = { start: 0, end: 0, statements: 0, rowsOut: 0 };
  window.addEventListener('weather:sql', (event) => {
    const { ms, rows } = event.detail;
    const now = performance.now();
    if (now - burst.end > 400) {
      burst.start = now - ms;
      burst.statements = 0;
      burst.rowsOut = 0;
    }
    burst.end = now;
    burst.statements += 1;
    burst.rowsOut += rows;
    built.lastBurst = { ms: Math.round(burst.end - burst.start), statements: burst.statements, rowsOut: burst.rowsOut };
    renderLive();
  });

  let rangeTally = null;
  async function pollRanges() {
    const tally = await readRangeAccounting();
    const file = tally?.files?.find((f) => f.path.endsWith(facts ? facts.file.split('/').pop() : '.parquet'));
    rangeTally = file ?? null;
    renderLive();
  }

  function renderLive() {
    const parts = [];
    const matched = built.matchCount;
    const total = built.totalRows;
    if (matched != null) {
      parts.push(`<b data-live-matched>${fmt.int(matched)}</b>${total ? ` of ${fmt.int(total)}` : ''} station-days match`);
    }
    if (built.lastBurst) {
      parts.push(`last interaction: <b data-live-ms>${fmt.ms(built.lastBurst.ms)}</b> across ${built.lastBurst.statements} ${built.lastBurst.statements === 1 ? 'query' : 'queries'}`);
    }
    if (rangeTally) {
      parts.push(`<b>${fmt.int(rangeTally.partial)}</b> range reads, ${fmt.bytes(rangeTally.bytes)} of a ${fmt.bytes(rangeTally.size)} file`);
    }
    liveLine.innerHTML = parts.map((p) => `<span>${p}</span>`).join('');
  }

  /* ------------------------------------------------------------------ */
  /* The source, and the grid over it                                    */
  /* ------------------------------------------------------------------ */

  const adapter = LG.duckdbAdapter({
    connection: recordSql(connection),
    from: `read_parquet('${FILE}')`,
    fields: GRID_FIELDS,
  });
  const source = LG.createPushdownSource({
    adapter,
    compute: LG,
    pageSize: 200,
    aggregates: { default: 'engine-if-identical' },
  });
  built.adapter = adapter;
  built.source = source;

  const grid = LG.createGrid(gridHost, {
    rowKey: 'row_id',
    columns: COLUMNS,
    source,
    selection: 'single',
    facets: { enabled: true, provider: makeFacetProvider(source) },
    toolPanel: { side: 'right', panels: ['filters', 'columns'] },
    showTotalInHeader: true,
    groupFooter: true,
    grandTotalRow: 'bottom',
    groupDefaultExpanded: false,
  });
  built.grid = grid;

  /* The rows query carries the match count in the same statement as the page. */
  const innerExecute = adapter.execute.bind(adapter);
  adapter.execute = async (query, request) => {
    const result = await innerExecute(query, request);
    if (!query.groupBy?.length) {
      built.matchCount = typeof result.total === 'number' ? result.total : built.matchCount;
      if (built.totalRows == null && !query.filters) built.totalRows = built.matchCount;
    }
    built.plan = source.lastPlan?.() ?? null;
    renderLive();
    return result;
  };

  /* ------------------------------------------------------------------ */
  /* The chart, bound to the grid                                        */
  /* ------------------------------------------------------------------ */

  const chartBox = el('div', 'chart-box');
  chartBox.dataset.chart = 'months';
  const calendarBox = el('div', 'chart-box');
  calendarBox.dataset.chart = 'calendar';
  chartRow.append(chartBox, calendarBox);

  /*
   * Bound to the grid, not to a copy of its rows. The grid holds 200 of
   * millions, so a chart that read them would draw a page; with a pushdown
   * source the chart asks the engine instead (`aggregate: 'engine'`), and
   * the month on x and the averages on y become one GROUP BY over every row
   * the filters match.
   */
  try {
    built.chart = createChart({
      grid,
      container: chartBox,
      type: 'combo',
      x: 'month',
      measures: [
        { col: 'tmax_c', fn: 'avg', type: 'line', title: 'Average high °C' },
        { col: 'tmin_c', fn: 'avg', type: 'line', title: 'Average low °C' },
      ],
      aggregate: 'engine',
      title: 'Temperature by month',
      subtitle: 'Average high and low, over every station-day the filters match',
      axis: { y: '°C', x: { scale: 'band' } },
    });
  } catch (error) {
    chartBox.append(el('p', 'chart-error', `This chart could not be drawn: ${error.message}`));
    console.error('[weather demo] chart', error);
  }

  /* ------------------------------------------------------------------ */
  /* The calendar: one station's year                                    */
  /* ------------------------------------------------------------------ */

  const calendarHead = el('div', 'calendar-head');
  const stationSelect = el('select', 'input');
  stationSelect.dataset.control = 'station';
  for (const s of CALENDAR_STATIONS) stationSelect.append(new Option(s.label, s.id));
  const measureSelect = el('select', 'input');
  measureSelect.dataset.control = 'measure';
  for (const [value, label] of [['tmax_c', 'High °C'], ['tmin_c', 'Low °C'], ['prcp_mm', 'Rain mm'], ['snow_mm', 'Snow mm']]) {
    measureSelect.append(new Option(label, value));
  }
  calendarHead.append(field('Station', stationSelect), field('Show', measureSelect));
  const calendarHint = el('p', 'chart-hint', 'Select a row in the table to see that station’s year here.');
  calendarBox.append(calendarHead, calendarHint);
  const calendarCanvas = el('div', 'calendar-canvas');
  calendarBox.append(calendarCanvas);

  let calendarSequence = 0;
  async function showStation(stationId, label) {
    const sequence = ++calendarSequence;
    built.calendarStation = stationId;
    const measure = measureSelect.value;
    const statement = await recordSql(connection).prepare(
      `SELECT row_id, strftime(date, '%Y-%m-%d') AS day, tmax_c, tmin_c, prcp_mm, snow_mm, station_name, state
       FROM read_parquet('${FILE}') WHERE station_id = ? ORDER BY date`,
    );
    const result = await statement.query(stationId);
    statement.close?.();
    if (sequence !== calendarSequence) return;
    const rows = result.toArray().map((r) => {
      const o = r.toJSON();
      return {
        row_id: num(o.row_id), day: String(o.day),
        tmax_c: num(o.tmax_c), tmin_c: num(o.tmin_c), prcp_mm: num(o.prcp_mm), snow_mm: num(o.snow_mm),
      };
    });
    const name = label ?? (result.numRows ? String(result.get(0).toJSON().station_name) : stationId);
    const columns = [
      { field: 'row_id' }, { field: 'day', type: 'date' },
      { field: 'tmax_c', type: 'number' }, { field: 'tmin_c', type: 'number' },
      { field: 'prcp_mm', type: 'number' }, { field: 'snow_mm', type: 'number' },
    ];
    built.calendarRows = rows.length;
    if (built.calendarGrid) built.calendarGrid.destroy?.();
    built.calendarGrid = LG.createHeadlessGrid({ rowKey: 'row_id', columns, rows });
    built.calendar?.destroy?.();
    calendarCanvas.textContent = '';
    const titles = { tmax_c: 'Daily high, °C', tmin_c: 'Daily low, °C', prcp_mm: 'Daily rain, mm', snow_mm: 'Daily snow, mm' };
    try {
      built.calendar = createChart({
        grid: built.calendarGrid,
        container: calendarCanvas,
        type: 'calendar',
        x: 'day',
        y: measure,
        legend: false,
        title: `${name}, 2025`,
        subtitle: `${titles[measure]}, one square per day`,
      });
    } catch (error) {
      calendarCanvas.append(el('p', 'chart-error', `This chart could not be drawn: ${error.message}`));
      console.error('[weather demo] calendar', error);
    }
  }
  stationSelect.addEventListener('change', () => showStation(stationSelect.value, stationSelect.selectedOptions[0].textContent));
  measureSelect.addEventListener('change', () => showStation(built.calendarStation ?? stationSelect.value, null));

  grid.on('selection:changed', (event) => {
    const row = event.rows?.[0];
    if (!row?.station_id) return;
    const known = [...stationSelect.options].find((o) => o.value === row.station_id);
    if (known) stationSelect.value = row.station_id;
    else {
      stationSelect.querySelector('option[data-picked]')?.remove();
      const picked = new Option(`${row.station_name}, ${row.state}`, row.station_id);
      picked.dataset.picked = '';
      stationSelect.prepend(picked);
      stationSelect.value = row.station_id;
    }
    showStation(row.station_id, `${row.station_name}, ${row.state}`);
  });

  /* ------------------------------------------------------------------ */
  /* The SQL panel                                                       */
  /* ------------------------------------------------------------------ */

  const sqlHead = el('div', 'sql-head');
  sqlHead.append(el('h2', null, 'What went to DuckDB'));
  const sqlSummary = el('p', 'sql-summary');
  sqlSummary.dataset.planSummary = '';
  sqlHead.append(sqlSummary);
  const sqlPre = el('pre', 'sql-text');
  sqlPre.dataset.planSql = '';
  sqlPre.tabIndex = 0;
  sqlPre.textContent = '-- the statements DuckDB ran appear here';
  sqlSection.append(sqlHead, sqlPre);

  function renderSql() {
    const recent = sqlLog.slice(-4);
    if (!recent.length) return;
    sqlPre.textContent = recent.map((e) => {
      const bound = e.params?.length ? `\n-- bound: ${JSON.stringify(e.params, (_, v) => (typeof v === 'bigint' ? String(v) : v))}` : '';
      return `${e.sql.trim().replace(/\s+/g, ' ')}${bound}\n-- ${fmt.int(e.rows)} rows back in ${fmt.ms(e.ms)}`;
    }).join('\n\n');
    const plan = built.plan;
    const unpushed = plan?.unpushed ?? [];
    sqlSummary.textContent = unpushed.length
      ? `Kept in the browser: ${unpushed.join(', ')}.`
      : 'Filter, sort, quick search, paging and grouping all ran in DuckDB; nothing was left for the browser.';
  }
  window.addEventListener('weather:sql', () => { renderSql(); void pollRanges(); });

  footer.append(
    el('p', null,
      'Data: NOAA Global Historical Climatology Network – Daily (GHCN-Daily), 2025, US stations, public domain (CC0). '
      + 'Credit: NOAA National Centers for Environmental Information. Values are in °C and millimetres; a reading NOAA flagged as '
      + 'failing a quality check is left out, and a day a station did not report a value is blank.'),
    el('p', null, `DuckDB-Wasm ${duckdbVersion} · ${useLocal() ? 'data read from this machine' : 'data read from data.latticegrid.dev'}.`),
  );

  /* ------------------------------------------------------------------ */
  /* States for the select                                               */
  /* ------------------------------------------------------------------ */

  (async () => {
    const result = await recordSql(connection).query(
      `SELECT DISTINCT state FROM read_parquet('${FILE}') ORDER BY state`,
    );
    for (const r of result.toArray()) stateSelect.append(new Option(String(r.toJSON().state), String(r.toJSON().state)));
    void showStation(CALENDAR_STATIONS[0].id, CALENDAR_STATIONS[0].label);
  })().catch((error) => console.error('[weather demo] states', error));

  built.settled = () => Boolean(grid.rows.count() > 0 && built.matchCount != null && built.calendarRows != null);
  built.destroy = () => {
    built.chart?.destroy?.();
    built.calendar?.destroy?.();
    grid.destroy?.();
  };
  return built;
}
