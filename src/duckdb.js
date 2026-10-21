/**
 * DuckDB-Wasm, started in the page.
 *
 * The grid ships no engine. `duckdbAdapter` takes a connection the host made
 * and imports nothing, so everything about DuckDB — which version, where it
 * comes from, what extensions are loaded — is decided here and nowhere else.
 *
 * `LOAD httpfs` matters: without it DuckDB's HTTP filesystem is not in play
 * and the engine reads the whole Parquet file in one GET before it can answer
 * anything. With it the file is opened by its footer and read in byte ranges.
 */

/** Pinned. A CDN import with no version is a demo that breaks on someone else's release day. */
export const DUCKDB_VERSION = '1.32.0';
export const DUCKDB_MODULE = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_VERSION}/+esm`;

/**
 * Start the engine and open a connection with httpfs loaded.
 *
 * @param {(message: string) => void} [onStatus] progress, for the loading panel
 */
export async function startDuckDB(onStatus = () => {}) {
  onStatus(`Loading DuckDB-Wasm ${DUCKDB_VERSION} from jsDelivr...`);
  const duckdb = await import(/* @vite-ignore */ DUCKDB_MODULE);
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());

  onStatus('Starting the engine...');
  const worker = await duckdb.createWorker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.ERROR), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

  const connection = await db.connect();
  await connection.query('LOAD httpfs;');
  await connection.query('SET enable_http_metadata_cache = true;');
  await connection.query('SET enable_object_cache = true;');

  const version = (await readOne(connection, 'SELECT version() AS v'))?.v ?? 'unknown';

  return {
    duckdb,
    db,
    connection,
    worker,
    version: String(version),
    close() {
      try { connection.close?.(); } catch { /* already gone */ }
      try { worker.terminate?.(); } catch { /* already gone */ }
    },
  };
}

/** One row of a one-row query, as a plain object. */
export async function readOne(connection, sql) {
  const result = await connection.query(sql);
  const rows = result.toArray().map((r) => r.toJSON());
  return rows[0] ?? null;
}

/**
 * Wrap a connection so every statement that passes through it is recorded.
 *
 * The adapter is handed the wrapper, never the connection, so no statement
 * reaches DuckDB unseen. That is what feeds the live timings and the SQL
 * panel: the text the engine actually ran, with the values bound to it and
 * how long it took.
 *
 * @param {object} connection a DuckDB-Wasm connection
 * @param {(entry: {sql: string, params: unknown[], ms: number, rows: number}) => void} record
 */
export function recordingConnection(connection, record) {
  const note = (sql, params, started, result) => {
    const rows = typeof result?.numRows === 'number' ? result.numRows : 0;
    record({ sql, params, ms: Math.round(performance.now() - started), rows });
  };
  return {
    query: async (sql) => {
      const started = performance.now();
      const result = await connection.query(sql);
      note(sql, [], started, result);
      return result;
    },
    prepare: async (sql) => {
      const statement = await connection.prepare(sql);
      return {
        query: async (...params) => {
          const started = performance.now();
          const result = await statement.query(...params);
          note(sql, params, started, result);
          return result;
        },
        close: () => statement.close?.(),
      };
    },
  };
}

/** Whether the byte-accounting endpoint of tools/serve.mjs can exist at all. */
const hasRangeAccounting = () => (
  location.protocol !== 'file:'
  && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname)
);

/**
 * The byte accounting, read back from the server that served the file.
 *
 * DuckDB reads inside a worker, so nothing in the page can observe its
 * requests. `tools/serve.mjs` records every request for a file under `data/`
 * and serves the tally at `/__ranges`. Only asked for on localhost with
 * `?data=local`, so a static host never sees a doomed request.
 *
 * @returns {Promise<object|null>} null wherever no such server is listening
 */
export async function readRangeAccounting() {
  if (!hasRangeAccounting()) return null;
  try {
    const response = await fetch('./__ranges', { cache: 'no-store' });
    if (!response.ok) return null;
    const body = await response.json();
    return body && Array.isArray(body.files) ? body : null;
  } catch {
    return null;
  }
}

/** Clear the server's range tally, so the next measurement starts from zero. */
export async function resetRangeAccounting() {
  if (!hasRangeAccounting()) return false;
  try {
    await fetch('./__ranges', { method: 'POST', cache: 'no-store' });
    return true;
  } catch {
    return false;
  }
}
