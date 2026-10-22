/**
 * What the data is, and how the grid should read it.
 *
 * One row per US weather station per day of 2025, from NOAA GHCN-Daily,
 * converted to a single Parquet file by tools/build-parquet.mjs. Every column
 * here exists in that file; nothing is computed in the page that the engine
 * could compute instead.
 */

/**
 * Only these columns are selected. The adapter's default is `SELECT *`, which
 * on a columnar file reads every column chunk of every row group the query
 * touches. Naming the fields keeps a page fetch to the columns on screen.
 */
export const GRID_FIELDS = [
  'row_id', 'station_id', 'station_name', 'state', 'latitude', 'longitude', 'elevation_m',
  'date', 'month', 'tmax_c', 'tmin_c', 'prcp_mm', 'snow_mm',
];

/** The columns the opening chart groups and averages: it reads these across the whole file. */
const CHART_FIELDS = ['month', 'tmax_c', 'tmin_c'];

/**
 * How many compressed bytes of the Parquet file the opening views will read,
 * from the file's footer: the first row group in full (the first page of rows)
 * plus the chart's three columns across every row group (the monthly
 * averages). It is what the "n of m MB" line counts to.
 */
export const readBytesSql = (url) => {
  const list = (names) => names.map((f) => `'${f}'`).join(', ');
  return `SELECT CAST(sum(total_compressed_size) AS BIGINT) AS bytes
  FROM parquet_metadata('${url.replaceAll("'", "''")}')
  WHERE path_in_schema IN (${list(CHART_FIELDS)})
     OR (row_group_id = 0 AND path_in_schema IN (${list(GRID_FIELDS)}))`;
};

export const MONTHS = [
  '01 Jan', '02 Feb', '03 Mar', '04 Apr', '05 May', '06 Jun',
  '07 Jul', '08 Aug', '09 Sep', '10 Oct', '11 Nov', '12 Dec',
];

/** The two thresholds the "hot" and "wet" presets and the cell highlights share. */
export const HOT_C = 35;
export const WET_MM = 25;

const degrees = { decimals: 1 };
const millimetres = { decimals: 1 };

/**
 * The grid's columns.
 *
 * Every filter here is one the DuckDB adapter declares it can apply, so the
 * whole filter tree goes to the engine. `total: 'avg'` is the reduction shown
 * on a group's footer row and in the grand total: with the group pushed down it
 * is an `avg()` in the engine, over every row in the group.
 */
export const COLUMNS = [
  {
    field: 'station_name', title: 'Station', filter: { type: 'text' },
    layout: { width: 210, pin: 'start' }, facet: false,
  },
  { field: 'state', title: 'State', filter: { type: 'set' }, layout: { width: 90 }, facet: { cardinalityLimit: 60 } },
  {
    field: 'date', title: 'Date', type: 'date', filter: { type: 'date' },
    layout: { width: 124 },
  },
  { field: 'month', title: 'Month', filter: { type: 'set' }, layout: { width: 104 }, facet: false },
  {
    field: 'tmax_c', title: 'High °C', type: 'number', filter: { type: 'number' },
    format: degrees, total: 'avg', layout: { width: 118 },
    /* Hot is the thing a reader looks for, so hot is marked. */
    cell: {
      decoration: 'pill',
      variant: { when: [{ op: 'gte', value: HOT_C, use: 'danger' }, { op: 'gte', value: 30, use: 'warning' }], default: 'none' },
    },
  },
  {
    field: 'tmin_c', title: 'Low °C', type: 'number', filter: { type: 'number' },
    format: degrees, total: 'avg', layout: { width: 118 },
  },
  {
    field: 'prcp_mm', title: 'Rain mm', type: 'number', filter: { type: 'number' },
    format: millimetres, total: 'avg', layout: { width: 118 },
    cell: { decoration: 'pill', variant: { when: [{ op: 'gte', value: WET_MM, use: 'info' }], default: 'none' } },
  },
  {
    field: 'snow_mm', title: 'Snow mm', type: 'number', filter: { type: 'number' },
    format: { decimals: 0 }, total: 'avg', layout: { width: 118 }, facet: false,
  },
  {
    field: 'elevation_m', title: 'Elevation m', type: 'number', filter: { type: 'number' },
    format: { decimals: 0 }, layout: { width: 124, hidden: true }, facet: false,
  },
  { field: 'station_id', title: 'Station id', filter: { type: 'text' }, layout: { width: 130, hidden: true }, facet: false },
  { field: 'latitude', title: 'Latitude', type: 'number', format: { decimals: 4 }, layout: { width: 104, hidden: true }, facet: false },
  { field: 'longitude', title: 'Longitude', type: 'number', format: { decimals: 4 }, layout: { width: 104, hidden: true }, facet: false },
];

/** Preset filters. Each is an ordinary filter tree, so it takes the same route a header filter does. */
export const PRESETS = [
  { id: 'hot', label: `Hot days, ${HOT_C} °C and up`, tree: { col: 'tmax_c', op: 'gte', value: HOT_C } },
  { id: 'wet', label: `Wet days, ${WET_MM} mm and up`, tree: { col: 'prcp_mm', op: 'gte', value: WET_MM } },
  { id: 'snow', label: 'Snowfall of 100 mm or more', tree: { col: 'snow_mm', op: 'gte', value: 100 } },
  { id: 'freeze', label: 'High below −20 °C', tree: { col: 'tmax_c', op: 'lt', value: -20 } },
];

/** The stations the calendar offers first. All are long-running airport or city stations. */
export const CALENDAR_STATIONS = [
  { id: 'USW00094728', label: 'New York, Central Park' },
  { id: 'USW00023174', label: 'Los Angeles Airport' },
  { id: 'USW00023183', label: 'Phoenix Sky Harbor' },
  { id: 'USW00094846', label: 'Chicago O’Hare' },
  { id: 'USW00027502', label: 'Utqiaġvik, Alaska' },
];

/** Formatting used in the tiles, the panels and the labels. */
export const fmt = {
  int: (n) => (n == null ? '—' : Number(n).toLocaleString('en-US')),
  ms: (n) => (n == null ? '—' : `${Math.round(Number(n)).toLocaleString('en-US')} ms`),
  bytes: (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    if (v < 1024) return `${v} B`;
    if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`;
    return `${(v / 1048576).toFixed(1)} MB`;
  },
};

/** A DuckDB `count(*)` arrives as a BigInt; everything downstream wants a number. */
export const num = (value) => (typeof value === 'bigint' ? Number(value) : (value == null ? null : Number(value)));
