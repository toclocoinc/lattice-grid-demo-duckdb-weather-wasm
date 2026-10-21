# The data

`weather-2025.parquet` is **not committed**. It is built from public sources by
`npm run build-data` (Node 22, `@duckdb/node-api`) and hosted at
`https://data.latticegrid.dev/duckdb/lattice-grid-demo-duckdb-weather-wasm/weather-2025.parquet`
(GitHub Pages cannot serve Parquet range reads). The page reads that URL by
default; `?data=local` reads `data/weather-2025.parquet` from `npm start`.
The one constant lives in `src/config.js`.

## Source, licence, attribution

- **NOAA Global Historical Climatology Network – Daily (GHCN-Daily)**, 2025,
  <https://registry.opendata.aws/noaa-ghcn/>.
  - Observations: `https://noaa-ghcn-pds.s3.amazonaws.com/csv.gz/by_year/2025.csv.gz`
  - Stations: `https://noaa-ghcn-pds.s3.amazonaws.com/ghcnd-stations.txt`
- Licence: **CC0 / public domain** (NOAA open data).
- Credit: **NOAA National Centers for Environmental Information**.

NOAA rewrites the by-year file as late reports and corrections arrive, so a
rebuild on a later day can differ by a few rows from the numbers below.

## What the build does

US stations (GHCN ids starting `US`, 50 states and DC), elements `TMAX`, `TMIN`,
`PRCP`, `SNOW`, pivoted to **one row per station-day** and joined to the station
list. Readings NOAA flagged as failing a quality check are dropped. Values are
in degrees C and millimetres (GHCN stores tenths; `round(x / 10, 1)`). A reading
not reported is null, never zero: about 70 % of station-days carry no
temperature (rain-gauge-only stations), which the histograms leave out of their bars.
Sorted by state, station (highest id first, so full-record airport stations lead
the precipitation-only ones) and date; zstd; `ROW_GROUP_SIZE 100000`.

Columns: `row_id`, `station_id`, `station_name`, `state`, `latitude`,
`longitude`, `elevation_m`, `date`, `month` (`01 Jan`..`12 Dec`), `tmax_c`,
`tmin_c`, `prcp_mm`, `snow_mm`.

## Measured on the build of 2026-10-21

`SELECT count(*)` over the file, and the file itself (also in `facts.json`):

| | |
|---|---|
| Rows (station-days) | **8,759,064** |
| Stations / states | 32,936 / 51 |
| Dates | 2025-01-01 to 2025-12-31 |
| Row groups | 88 (of ~100,000 rows) |
| File size | **39,028,193 bytes (37.2 MB)** |
| Readings: tmax / tmin / prcp / snow | 2,605,576 / 2,601,944 / 8,127,967 / 5,494,376 |
| sha256 | `cf86f95d99a8ceb21d97b35266449c18ac56e93fb838d5f4a9876fb7162eb4e0` |
| Download (cached in `.cache/`) | 159.6 MB observations + 11.4 MB stations |
