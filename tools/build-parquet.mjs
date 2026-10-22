/**
 * Build data/weather-2025.parquet from NOAA GHCN-Daily.
 *
 * Everything comes from public sources, so anyone can reproduce the file:
 *
 *   - https://noaa-ghcn-pds.s3.amazonaws.com/csv.gz/by_year/2025.csv.gz
 *     every daily observation of 2025, all stations, all elements (~160 MB)
 *   - https://noaa-ghcn-pds.s3.amazonaws.com/ghcnd-stations.txt
 *     the station list: name, state, latitude, longitude, elevation
 *
 * (The dataset is described at https://registry.opendata.aws/noaa-ghcn/ and
 * is CC0 / public domain; credit: NOAA National Centers for Environmental
 * Information.)
 *
 *   node tools/build-parquet.mjs               # 2025, the published file
 *   node tools/build-parquet.mjs --year 2024   # another year
 *
 * What it does:
 *
 *   1. Downloads both files into .cache/ unless a copy is already there.
 *   2. Keeps US stations (GHCN ids that start with "US") and the elements
 *      TMAX, TMIN, PRCP and SNOW, and drops any reading NOAA flagged as
 *      failing a quality check.
 *   3. Pivots to ONE ROW PER STATION-DAY and joins the station's metadata.
 *      Values are converted from GHCN's tenths to degrees Celsius and
 *      millimetres.
 *   4. Writes one zstd Parquet file, sorted by state, station and date, in
 *      row groups of ~100,000 rows. Stations run from the highest id down, so
 *      the full-record airport stations (USW...) come ahead of the
 *      precipitation-only cooperative ones (US1...) and the first screen of
 *      rows is real weather, not a page of blank temperatures.
 *
 * The sort and the row-group size are the point. DuckDB-Wasm reads the file
 * over HTTP with range requests and can skip a row group only when its
 * min/max statistics rule it out. Sorted by state, a state filter touches a
 * few groups; sorted by station and date inside a state, one station's year
 * is a single group.
 *
 * Nothing is invented. A reading NOAA did not report is null, never zero.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const cache = join(root, '.cache');

const args = process.argv.slice(2);
const year = Number(args.includes('--year') ? args[args.indexOf('--year') + 1] : 2025);
if (!Number.isInteger(year) || year < 1900 || year > 2100) throw new Error(`--year wants a year, got "${year}"`);

const BASE = 'https://noaa-ghcn-pds.s3.amazonaws.com';
const OBS_URL = `${BASE}/csv.gz/by_year/${year}.csv.gz`;
const STATIONS_URL = `${BASE}/ghcnd-stations.txt`;
const obsFile = join(cache, `${year}.csv.gz`);
const stationsFile = join(cache, 'ghcnd-stations.txt');
const outFile = join(root, 'data', `weather-${year}.parquet`);

const ROW_GROUP_SIZE = 100000;

const exists = async (path) => {
  try { await access(path); return true; } catch { return false; }
};
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

async function download(url, file) {
  if (await exists(file)) {
    console.log(`Using the cached download: ${file}`);
    return;
  }
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(`${file}.part`));
  const { rename } = await import('node:fs/promises');
  await rename(`${file}.part`, file);
  console.log(`  ${mb((await stat(file)).size)}`);
}

await mkdir(cache, { recursive: true });
await mkdir(join(root, 'data'), { recursive: true });
await download(OBS_URL, obsFile);
await download(STATIONS_URL, stationsFile);

const { DuckDBInstance } = await import('@duckdb/node-api');
const db = await DuckDBInstance.create(':memory:');
const conn = await db.connect();
await conn.run('SET threads TO 4');

const q = (text) => text.replaceAll("'", "''");

/*
 * The station list is fixed-width (see ghcnd-readme.txt):
 *   ID 1-11, LATITUDE 13-20, LONGITUDE 22-30, ELEVATION 32-37, STATE 39-40, NAME 42-71.
 * Elevation -999.9 means unknown.
 */
await conn.run(`
  CREATE TABLE stations AS
  SELECT
    trim(substr(line, 1, 11))                       AS station_id,
    trim(substr(line, 42, 30))                      AS station_name,
    nullif(trim(substr(line, 39, 2)), '')           AS state,
    try_cast(trim(substr(line, 13, 8)) AS DOUBLE)   AS latitude,
    try_cast(trim(substr(line, 22, 9)) AS DOUBLE)   AS longitude,
    nullif(try_cast(trim(substr(line, 32, 6)) AS DOUBLE), -999.9) AS elevation_m
  FROM read_csv('${q(stationsFile)}', columns = {'line': 'VARCHAR'}, header = false,
                delim = '\\x01', quote = '', escape = '')
  WHERE substr(line, 1, 2) = 'US'
`);

console.log('Reading the observations, pivoting and writing the Parquet file...');
/*
 * Q_FLAG is blank when the reading passed NOAA's quality checks. A reading
 * with any flag is dropped: it is not a measurement NOAA stands behind.
 *
 * Values are tenths of a degree C, tenths of a mm, and whole mm of snowfall.
 * `month` is "01 Jan" .. "12 Dec" so it sorts in calendar order and reads as
 * a label in a group row or a chart axis without a lookup.
 */
await conn.run(`
  COPY (
    WITH obs AS (
      SELECT
        ID AS station_id,
        strptime(CAST(DATE AS VARCHAR), '%Y%m%d')::DATE AS day,
        ELEMENT AS element,
        DATA_VALUE AS value
      FROM read_csv('${q(obsFile)}', header = false, compression = 'gzip',
        columns = {'ID': 'VARCHAR', 'DATE': 'INTEGER', 'ELEMENT': 'VARCHAR', 'DATA_VALUE': 'INTEGER',
                   'M_FLAG': 'VARCHAR', 'Q_FLAG': 'VARCHAR', 'S_FLAG': 'VARCHAR', 'OBS_TIME': 'VARCHAR'})
      WHERE ID LIKE 'US%'
        AND ELEMENT IN ('TMAX', 'TMIN', 'PRCP', 'SNOW')
        AND (Q_FLAG IS NULL OR Q_FLAG = '')
        AND DATA_VALUE IS NOT NULL
    ),
    wide AS (
      SELECT
        station_id, day,
        max(CASE WHEN element = 'TMAX' THEN value END) AS tmax,
        max(CASE WHEN element = 'TMIN' THEN value END) AS tmin,
        max(CASE WHEN element = 'PRCP' THEN value END) AS prcp,
        max(CASE WHEN element = 'SNOW' THEN value END) AS snow
      FROM obs
      GROUP BY station_id, day
    )
    SELECT
      row_number() OVER (ORDER BY s.state, w.station_id DESC, w.day)::INTEGER AS row_id,
      w.station_id,
      s.station_name,
      s.state,
      s.latitude,
      s.longitude,
      s.elevation_m,
      w.day AS date,
      (lpad(month(w.day)::VARCHAR, 2, '0') || ' ' || strftime(w.day, '%b'))::VARCHAR AS month,
      round(w.tmax / 10.0, 1) AS tmax_c,
      round(w.tmin / 10.0, 1) AS tmin_c,
      round(w.prcp / 10.0, 1) AS prcp_mm,
      w.snow::SMALLINT AS snow_mm
    FROM wide w
    JOIN stations s USING (station_id)
    WHERE s.state IS NOT NULL
    ORDER BY s.state, w.station_id DESC, w.day
  ) TO '${q(outFile)}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE ${ROW_GROUP_SIZE}, WRITE_BLOOM_FILTER false)
`);

const quoted = q(outFile);
const facts = (await conn.runAndReadAll(`
  SELECT
    count(*)                        AS rows,
    count(DISTINCT station_id)      AS stations,
    count(DISTINCT state)           AS states,
    min(date)                       AS first_date,
    max(date)                       AS last_date,
    count(tmax_c)                   AS tmax_readings,
    count(tmin_c)                   AS tmin_readings,
    count(prcp_mm)                  AS prcp_readings,
    count(snow_mm)                  AS snow_readings
  FROM read_parquet('${quoted}')
`)).getRowObjects()[0];
const groups = (await conn.runAndReadAll(`
  SELECT count(*) AS row_groups FROM parquet_metadata('${quoted}') WHERE column_id = 0
`)).getRowObjects()[0];

const size = (await stat(outFile)).size;
const sha256 = createHash('sha256').update(await readFile(outFile)).digest('hex');
const summary = {
  file: `data/weather-${year}.parquet`,
  bytes: size,
  megabytes: Number((size / 1048576).toFixed(2)),
  sha256,
  rows: Number(facts.rows),
  row_groups: Number(groups.row_groups),
  row_group_size: ROW_GROUP_SIZE,
  stations: Number(facts.stations),
  states: Number(facts.states),
  first_date: String(facts.first_date),
  last_date: String(facts.last_date),
  readings: {
    tmax: Number(facts.tmax_readings),
    tmin: Number(facts.tmin_readings),
    prcp: Number(facts.prcp_readings),
    snow: Number(facts.snow_readings),
  },
  source: OBS_URL,
  stations_source: STATIONS_URL,
  built: new Date().toISOString().slice(0, 10),
};
await writeFile(join(root, 'data', 'facts.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));

conn.closeSync();
if (size > 200 * 1048576) {
  console.error(`\nThat file is ${mb(size)}, over the 200 MB target.`);
  process.exitCode = 1;
}
