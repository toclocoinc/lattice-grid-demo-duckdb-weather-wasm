/**
 * The entry point.
 *
 * Starts DuckDB, hands the connection to the dashboard and gets out of the
 * way. Nothing here is awaited at the top level: a module with a pending
 * top-level await leaves the document in its loading state, which blocks a
 * headless browser's evaluations. `start()` is called and the module finishes.
 */

import * as LG from 'https://cdn.latticegrid.dev/lattice-grid@1.111.7/lattice-grid.esm.min.js?v=1.111.7-20261022';
import { createChart } from 'https://cdn.latticegrid.dev/lattice-grid@1.111.7/modules/charts.esm.min.js?v=1.111.7-20261022';
import 'https://cdn.latticegrid.dev/lattice-grid@1.111.7/modules/chart-calendar.esm.min.js?v=1.111.7-20261022';
import { DEMO_LICENCE } from './src/licence.js';
import { startDuckDB, recordingConnection, resetRangeAccounting } from './src/duckdb.js';
import { dataUrl } from './src/config.js';
import { buildDashboard } from './src/dashboard.js';
import { createStatus, megabytes } from './src/loading.js';
import { readBytesSql } from './src/weather.js';

/* Applied before anything is drawn: a grid keeps whatever licence was in force when it was built. */
LG.setLicence(DEMO_LICENCE);

const root = document.querySelector('#app');
const TITLE = 'US daily weather, 2025';

/** The statements DuckDB ran, newest last. The query panel reads this. */
const sqlLog = [];
const recordSql = (connection) => recordingConnection(connection, (entry) => {
  sqlLog.push(entry);
  if (sqlLog.length > 200) sqlLog.splice(0, sqlLog.length - 200);
  window.dispatchEvent(new CustomEvent('weather:sql', { detail: entry }));
});

/** The failure screen: replaces everything with what went wrong. */
function panel(title, ...lines) {
  root.textContent = '';
  const box = document.createElement('div');
  box.className = 'loading';
  const h1 = document.createElement('h1');
  h1.textContent = title;
  box.append(h1);
  const nodes = lines.map((text) => {
    const p = document.createElement('p');
    p.className = 'loading-message';
    p.textContent = text;
    box.append(p);
    return p;
  });
  root.append(box);
  return nodes;
}

function showError(error) {
  panel(
    'The weather could not be loaded',
    String(error?.message ?? error),
    'This page runs DuckDB compiled to WebAssembly, loaded from jsDelivr, and reads a Parquet file '
    + 'with HTTP range requests. It needs a browser with WebAssembly and a data host that answers 206 Partial Content.',
  );
  console.error('[weather demo]', error);
}

async function readFacts() {
  try {
    const response = await fetch('./data/facts.json', { cache: 'no-store' });
    if (response.ok) return await response.json();
  } catch { /* the page works without it */ }
  return null;
}

/**
 * How many bytes of the Parquet file the opening views will read: the
 * compressed size of the columns on screen, from the file's footer (which the
 * engine fetches anyway). Null when the footer cannot say, so the bar is
 * dropped rather than guessed.
 */
async function expectedBytes(connection, url) {
  try {
    const result = await connection.query(readBytesSql(url));
    return Number(result.toArray()[0]?.toJSON().bytes) || null;
  } catch { return null; }
}

async function start() {
  const started = performance.now();
  /* The status line is in index.html, so it is on screen from first paint. */
  const status = createStatus(root.querySelector('.load-status'));
  try {
    /* Clear the local server's byte tally so the readout covers this page load only. */
    await resetRangeAccounting();
    const { connection, version, close, reads } = await startDuckDB(
      (message) => status.set(message),
      ({ loaded, total }) => status.set(
        `Downloading the query engine (about ${Math.round(total / 1e6)} MB, first visit only): ${Math.round(loaded / 1e6)} of ${Math.round(total / 1e6)} MB`,
        loaded / total,
      ),
    );
    status.set('Looking up where the readings sit in the file');
    const [expected, facts] = await Promise.all([expectedBytes(connection, dataUrl()), readFacts()]);
    const before = reads.bytes;
    const line = (read) => {
      const total = Math.max(expected ?? 0, read);
      return expected
        ? [`Reading the 2025 weather readings (${megabytes(read)} of ${megabytes(total)})`, read / total]
        : [`Reading the 2025 weather readings (${megabytes(read)} so far)`, null];
    };
    status.set(...line(0));
    const stop = reads.onRead((total) => status.set(...line(total - before)));

    const built = buildDashboard({
      root, LG, createChart, connection, recordSql, sqlLog, duckdbVersion: version, facts, dataUrl: dataUrl(), status,
    });
    window.addEventListener('pagehide', () => { built.destroy(); close(); }, { once: true });

    /* Ready means the whole page is true: rows, count, charts and calendar drawn. */
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && !built.settled()) {
      await new Promise((r) => setTimeout(r, 150));
    }
    stop();
    status.hide();
    built.ready = true;
    built.bootMs = Math.round(performance.now() - started);
    window.__demo = built;
    console.log('[weather demo] ready', { ms: built.bootMs, rows: built.matchCount, duckdb: version });
  } catch (error) {
    window.__demo = { ready: false, error: String(error?.message ?? error) };
    showError(error);
  }
}

start();
