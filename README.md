# US daily weather, 2025: millions of rows, all in your browser

Lattice Grid over DuckDB-Wasm. 8.76 million station-days of NOAA GHCN-Daily in
one 37 MB Parquet file on a static host: no server, no API. DuckDB, compiled to
WebAssembly, reads the file in byte ranges; the grid turns every filter, sort,
quick search, page and group into SQL, and the temperature-by-month chart is
bound to the grid and computed by the engine too.

Plain JavaScript: `index.html`, `main.js`, `src/*.js`, `styles.css`. No
framework, no TypeScript, no bundler, no build step to run the page. The grid is
loaded from `node_modules` (`npm install`); DuckDB-Wasm 1.32.0 from jsDelivr.

```
npm install
npm run build-data   # downloads NOAA data, writes data/weather-2025.parquet (see data/README.md)
npm start            # http://localhost:<port>/?data=local
npm run verify       # headless Chrome against the local data
```

## On the page

- Filters: state, date range, search, quick chips for hot days (35 °C and up),
  wet days (25 mm and up), heavy snow and deep cold. Header filters and header
  histograms (counts from DuckDB over every matching row) work too.
- Group by state or by month, with averages on the group rows.
- Temperature by month chart (grid-bound, `aggregate: 'engine'`) and a calendar
  heatmap of one station's year (select a row to switch station).
- Live timings read from the statements DuckDB ran, and the SQL itself.

## Notes for the release owner

- Upload `data/weather-2025.parquet` to
  `https://data.latticegrid.dev/duckdb/lattice-grid-demo-duckdb-weather-wasm/`.
  The host must answer `Range` with `206`, send no `content-encoding`, and allow
  cross-origin reads (`Access-Control-Allow-Origin`, and expose
  `Content-Range`, `Accept-Ranges`, `Content-Length`).
- `.github/workflows/pages.yml` publishes the page only; verify needs the data.

## Known grid issues left out, not worked around

- `groupDefaultExpanded: 0` on a pushdown-grouped grid opens the first group
  anyway, and regrouping from one level to two leaves expanded children as
  skeleton rows. The demo therefore offers one grouping level at a time (state
  or month).
- `source.lastPlan()` reports `unpushed: ['group']` after a `source.aggregate()`
  call with a `groupBy`, so the SQL panel reads the plan's `residual` instead.

Data: NOAA National Centers for Environmental Information, GHCN-Daily, CC0.
