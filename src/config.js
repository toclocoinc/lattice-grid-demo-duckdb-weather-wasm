/**
 * Where the data lives.
 *
 * **This is the only place the Parquet file is named.** The page reads it from
 * data.latticegrid.dev, a host that answers HTTP range requests (GitHub Pages
 * cannot serve a Parquet file in byte ranges, so the file is not published
 * with the page). `?data=local` points the same page at `data/` on this
 * machine's `tools/serve.mjs`, for development and for `npm run verify`.
 *
 * `tools/verify.mjs` and `tools/build-parquet.mjs` read the file name from
 * here too, so renaming the file is one line and nothing else.
 */

export const DATA_NAME = 'weather-2025.parquet';

/** The published location: https://data.latticegrid.dev/duckdb/<demo-name>/ */
export const REMOTE_BASE = 'https://data.latticegrid.dev/duckdb/lattice-grid-demo-duckdb-weather-wasm/v2/';

/** The same file on a local `tools/serve.mjs`. */
export const LOCAL_BASE = './data/';

/** Whether the page was opened with `?data=local`. */
export const useLocal = () => new URLSearchParams(location.search).get('data') === 'local';

/** The absolute URL DuckDB opens. It resolves it itself, in a worker, so it must be absolute. */
export const dataUrl = () => new URL(DATA_NAME, new URL(useLocal() ? LOCAL_BASE : REMOTE_BASE, location.href)).href;
