/**
 * The entry point.
 *
 * Starts DuckDB, hands the connection to the dashboard and gets out of the
 * way. Nothing here is awaited at the top level: a module with a pending
 * top-level await leaves the document in its loading state, which blocks a
 * headless browser's evaluations. `start()` is called and the module finishes.
 */

import * as LG from './node_modules/@toclocoinc/lattice-grid/lattice-grid.esm.min.js';
import { createChart } from './node_modules/@toclocoinc/lattice-grid/modules/charts.esm.min.js';
import './node_modules/@toclocoinc/lattice-grid/modules/chart-calendar.esm.min.js';
import { DEMO_LICENCE } from './src/licence.js';
import { startDuckDB, recordingConnection, resetRangeAccounting } from './src/duckdb.js';
import { dataUrl } from './src/config.js';
import { buildDashboard } from './src/dashboard.js';

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

async function start() {
  const started = performance.now();
  const [line] = panel(TITLE, 'Starting DuckDB in your browser...');
  try {
    /* Clear the local server's byte tally so the readout covers this page load only. */
    await resetRangeAccounting();
    const { connection, version, close } = await startDuckDB((m) => { line.textContent = m; });
    line.textContent = 'Reading the Parquet file...';
    const facts = await readFacts();

    const built = buildDashboard({
      root, LG, createChart, connection, recordSql, sqlLog, duckdbVersion: version, facts, dataUrl: dataUrl(),
    });
    window.addEventListener('pagehide', () => { built.destroy(); close(); }, { once: true });

    /* Ready means the whole page is true: rows, count, charts and calendar drawn. */
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && !built.settled()) {
      await new Promise((r) => setTimeout(r, 150));
    }
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
