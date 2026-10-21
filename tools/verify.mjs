/**
 * Load the demo in headless Chrome against the local data and check it is
 * telling the truth.
 *
 * "It rendered" is not the claim, so it is not what is checked. Each
 * interaction below is made with real input events (mouse clicks, key presses,
 * wheel) and its result is compared with the same question answered by a
 * second DuckDB in Node, over the same Parquet file, in SQL written out here:
 *
 *   boot        row count and first rows are the file's
 *   quick       a hot-days chip, a state, a date range, the search box
 *   sort        a header click puts the file's true maximum first
 *   paging      scrolling fetches later rows from DuckDB
 *   grouping    group rows and their averages, by state and by state, month
 *   histograms  header bar counts add up to the readings in the file
 *   chart       engine-computed, month by month, and the calendar's year
 *   wire        every request for the Parquet file was a range read
 *   page        0 console errors, no NaN/undefined text, no watermark
 *
 * Usage:  node tools/verify.mjs [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { DATA_NAME } from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const args = process.argv.slice(2);
const shotDir = args.includes('--shots') ? resolve(args[args.indexOf('--shots') + 1]) : null;
const VIEWPORT = { width: 1440, height: 1000 };

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

async function findChrome() {
  for (const path of CHROME_CANDIDATES) {
    try { await access(path); return path; } catch { /* next */ }
  }
  throw new Error(`No browser found. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet CHROME_PATH.`);
}

const failures = [];
const notes = [];
function check(ok, description, detail) {
  const line = `${description}${detail !== undefined ? ` (${detail})` : ''}`;
  if (ok) notes.push(`  ok   ${line}`);
  else { failures.push(line); notes.push(`  FAIL ${line}`); }
}
const close = (a, b, tol = 0.051) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= tol;
const int = (n) => Number(n).toLocaleString('en-US');

/* ------------------------------------------------------------------ */
/* The independent answer: a second DuckDB, in Node                    */
/* ------------------------------------------------------------------ */

async function openNode() {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const conn = await (await DuckDBInstance.create(':memory:')).connect();
  const file = join(root, 'data', DATA_NAME).replaceAll("'", "''");
  const from = `read_parquet('${file}')`;
  const rows = async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJson();
  const one = async (sql) => (await rows(sql))[0];
  return { from, rows, one, close: () => conn.closeSync() };
}

/* ------------------------------------------------------------------ */
/* The browser                                                         */
/* ------------------------------------------------------------------ */

let browser = null;
let profile = null;
let served = null;
async function shutdown() {
  if (browser?.pid) {
    try { process.kill(-browser.pid, 'SIGKILL'); } catch { /* gone */ }
  }
  served?.server?.close();
  if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
}

async function run() {
  if (typeof WebSocket === 'undefined') throw new Error(`This check needs Node 22 or newer. You are on ${process.version}.`);
  try { await access(join(root, 'data', DATA_NAME)); } catch {
    throw new Error(`data/${DATA_NAME} is missing. Run: npm run build-data`);
  }
  const chromePath = await findChrome();
  const truth = await openNode();

  served = await startServer(0);
  const origin = `http://127.0.0.1:${served.port}`;
  console.log(`Browser: ${chromePath}\nServing: ${origin}`);

  profile = await mkdtemp(join(tmpdir(), 'weather-verify-'));
  const port = served.port + 1000 > 65000 ? 9333 : served.port + 1000;
  browser = spawn(chromePath, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-gpu',
    '--hide-scrollbars', `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, 'about:blank',
  ], { stdio: 'ignore', detached: true });

  let wsUrl;
  for (let i = 0; i < 150 && !wsUrl; i += 1) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(200); }
  }
  if (!wsUrl) throw new Error('the browser never opened its debugging port');
  const socket = new WebSocket(wsUrl);
  await new Promise((ok, fail) => { socket.onopen = ok; socket.onerror = () => fail(new Error('could not attach to the browser')); });

  let nextId = 0;
  const pending = new Map();
  const consoleErrors = [];
  socket.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.id != null && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.fail(new Error(JSON.stringify(m.error))); else p.ok(m.result);
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') consoleErrors.push(m.params.entry.text);
  };
  const send = (method, params = {}, sessionId) => new Promise((ok, fail) => {
    const id = ++nextId;
    pending.set(id, { ok, fail });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expression, what, ms = 90000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if (await evaluate(expression)) return true; } catch { /* page still loading */ }
      await sleep(150);
    }
    check(false, `waited for ${what}`, `${ms / 1000}s`);
    return false;
  };

  /* Real input. */
  const centre = async (selector) => evaluate(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    if (!e) return null;
    e.scrollIntoView({ block: 'center' });
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  const clickAt = async ({ x, y }) => {
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const click = async (selector) => {
    const at = await centre(selector);
    if (!at) throw new Error(`nothing to click: ${selector}`);
    await clickAt(at);
  };
  const typeText = async (text) => {
    for (const ch of text) {
      await call('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch });
      await call('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    }
  };
  const key = async (name) => {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: { Backspace: 8, Enter: 13 }[name] ?? 0 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name });
  };
  /* A <select> is chosen the way a person does: focus it and type the option. */
  const choose = async (selector, text) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await typeText(text);
  };
  const shot = async (name) => {
    if (!shotDir) return;
    await mkdir(shotDir, { recursive: true });
    const r = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(shotDir, `${name}.png`), Buffer.from(r.data, 'base64'));
  };

  const D = 'window.__demo';
  const HIGH_HEADER = '.lattice .lat-header-cell[data-col="tmax_c"] .lat-header-label, .lattice .lat-header-cell[data-col="tmax_c"]';
  const matched = () => evaluate(`${D}.matchCount`);
  const settleOn = async (expected, what) => waitFor(`${D}.matchCount === ${expected}`, what);
  const firstRow = () => evaluate(`(() => { const r = ${D}.grid.rows.get(0); return r && (r.data ?? r); })()`);
  /* After a change, the grid's window is replaced: wait for row 0 to be real. */
  const rowsReady = (what) => waitFor(`(() => { const r = ${D}.grid.rows.get(0); const d = r && (r.data ?? r); return d && d.station_id !== undefined; })()`, what);

  /* ---------------------------------------------------------------- boot */
  await call('Page.navigate', { url: `${origin}/?data=local` });
  const up = await waitFor(`${D} && ${D}.ready === true`, 'the page to be ready', 120000);
  if (!up) {
    const err = await evaluate(`${D} && ${D}.error`).catch(() => null);
    throw new Error(`the page never became ready${err ? `: ${err}` : ''}`);
  }
  console.log(`Ready in ${await evaluate(`${D}.bootMs`)} ms`);

  const total = Number((await truth.one(`SELECT count(*) AS n FROM ${truth.from}`)).n);
  check(await matched() === total, 'boot: the match count is the file\'s row count', `${int(total)}`);
  const firstTruth = await truth.one(`SELECT station_name, state, date::VARCHAR AS date, tmax_c, tmin_c, prcp_mm FROM ${truth.from} ORDER BY row_id LIMIT 1`);
  await rowsReady('the first rows');
  const first = await firstRow();
  check(first.station_name === firstTruth.station_name && first.state === firstTruth.state, 'boot: first row is the file\'s first row', `${first.station_name}, ${first.state}`);
  check(close(first.tmax_c, firstTruth.tmax_c) && close(first.prcp_mm, firstTruth.prcp_mm), 'boot: first row values match');
  const headline = await evaluate('document.querySelector("h1").textContent');
  check(headline.includes(`${(total / 1e6).toFixed(1)} million`), 'page: headline states the row count', headline);
  await shot('01-boot');

  /* ---------------------------------------------------------- histograms */
  for (const [col, sql] of [['tmax_c', 'count(tmax_c)'], ['tmin_c', 'count(tmin_c)'], ['prcp_mm', 'count(prcp_mm)'], ['state', 'count(*)'], ['date', 'count(*)']]) {
    const want = Number((await truth.one(`SELECT ${sql} AS n FROM ${truth.from}`)).n);
    const ok = await waitFor(`(() => { const f = ${D}.grid.facets.get(${JSON.stringify(col)}); return f && f.counts && f.counts.length > 0 && !f.stale; })()`, `the ${col} histogram`, 120000);
    const got = ok ? await evaluate(`Array.from(${D}.grid.facets.get(${JSON.stringify(col)}).counts).reduce((a, b) => a + b, 0)`) : null;
    check(got === want, `histogram: ${col} bars add up to the readings in the file`, `${int(got ?? 0)} of ${int(want)}`);
  }
  const bars = await evaluate('document.querySelectorAll(".lattice .lat-facet__bar").length');
  check(bars > 0, 'histogram: bars are drawn in the grid header', bars);

  /* --------------------------------------------------------------- chart */
  const prov = await evaluate(`${D}.chart.provenance()`);
  check(prov.source === 'engine' && !prov.refused, 'chart: temperature by month is computed by the engine', `${prov.source}`);
  const chartMarks = await evaluate('document.querySelectorAll("[data-chart=months] svg circle, [data-chart=months] svg path").length');
  check(chartMarks >= 24, 'chart: marks drawn for two lines over twelve months', chartMarks);
  const CY = 'JSON.stringify([...document.querySelectorAll("[data-chart=months] svg circle")].slice(0, 3).map((c) => Math.round(c.getAttribute("cy"))))';
  const bootMarks = await evaluate(CY);
  const monthly = await truth.rows(`SELECT month, avg(tmax_c) AS hi, avg(tmin_c) AS lo FROM ${truth.from} GROUP BY month ORDER BY month`);
  const chartText = await evaluate('document.querySelector("[data-chart=months]").textContent');
  check(monthly.every((m) => chartText.includes(m.month)), 'chart: every month is labelled', `${monthly.length} months`);
  const nyc = await truth.one(`SELECT count(*) AS n, max(tmax_c) AS hi FROM ${truth.from} WHERE station_id = 'USW00094728'`);
  check(await evaluate(`${D}.calendarRows`) === Number(nyc.n), 'calendar: the station\'s whole year is drawn', `${nyc.n} days`);
  const cells = await evaluate('document.querySelectorAll("[data-chart=calendar] svg rect").length');
  check(cells >= Number(nyc.n), 'calendar: a square per day', cells);
  const note = await evaluate('document.querySelector("[data-calendar-note]").textContent');
  check(note.includes(`Highest: ${nyc.hi} °C`), 'calendar: highest day matches the file', note);

  /* ------------------------------------------------------- hot days chip */
  const hot = Number((await truth.one(`SELECT count(*) AS n FROM ${truth.from} WHERE tmax_c >= 35`)).n);
  await click('[data-preset=hot]');
  await settleOn(hot, 'the hot-days count');
  check(await matched() === hot, 'filter: hot days chip matches the file', int(hot));
  await rowsReady('hot rows');
  const hotFirst = await truth.one(`SELECT station_name, date::VARCHAR AS date, tmax_c FROM ${truth.from} WHERE tmax_c >= 35 ORDER BY row_id LIMIT 1`);
  const hf = await firstRow();
  check(hf.station_name === hotFirst.station_name && close(hf.tmax_c, hotFirst.tmax_c), 'filter: first hot row is the file\'s', `${hf.station_name} ${hf.tmax_c}`);
  check(await evaluate(`${D}.grid.rows.count()`) > 0 && await evaluate(`${D}.plan.residual.filters == null`), 'filter: nothing left to the browser');
  await shot('02-hot');
  const hotMarks = await waitFor(`${CY} !== ${JSON.stringify(bootMarks)}`, 'the chart to follow the hot-days filter', 90000);
  check(hotMarks, 'chart: follows the grid\'s filter (hot days move the lines)');


  /* --------------------------------------------------------------- sort */
  const topTruth = await truth.one(`SELECT max(tmax_c) AS hi FROM ${truth.from} WHERE tmax_c >= 35`);
  const sortState = () => evaluate('document.querySelector(\'.lattice .lat-header-cell[data-col="tmax_c"]\').getAttribute("aria-sort")');
  await click(HIGH_HEADER);
  if (await sortState() !== 'descending') { await sleep(400); await click(HIGH_HEADER); }
  await waitFor(`(() => { const r = ${D}.grid.rows.get(0); const d = r && (r.data ?? r); return d && d.tmax_c === ${topTruth.hi}; })()`, 'the hottest day first', 60000);
  const top = await firstRow();
  check(close(top.tmax_c, topTruth.hi), 'sort: a header click puts the file\'s hottest day first', `${top.tmax_c} °C at ${top.station_name}, aria-sort ${await sortState()}`);
  await evaluate(`${D}.grid.sort.set([])`);

  /* --------------------------------------------------------------- clear */
  await click('[data-control=clear]');
  await settleOn(total, 'the cleared count');
  check(await waitFor(`${CY} === ${JSON.stringify(bootMarks)}`, 'the chart to return after the filter is cleared', 90000), 'chart: returns to the whole-year lines when the filter is cleared');

  /* ------------------------------------------------------------- state */
  const tx = Number((await truth.one(`SELECT count(*) AS n FROM ${truth.from} WHERE state = 'TX'`)).n);
  await choose('[data-control=state]', 'TX');
  await settleOn(tx, 'the Texas count');
  check(await matched() === tx, 'filter: state select matches the file', `TX ${int(tx)}`);

  /* -------------------------------------------------------- date range */
  const ranged = Number((await truth.one(`SELECT count(*) AS n FROM ${truth.from} WHERE state = 'TX' AND date BETWEEN DATE '2025-07-01' AND DATE '2025-07-31'`)).n);
  await evaluate(`(() => { for (const [c, v] of [['from', '2025-07-01'], ['to', '2025-07-31']]) { const i = document.querySelector('[data-control=' + c + ']'); i.value = v; i.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
  await settleOn(ranged, 'the date-range count');
  check(await matched() === ranged, 'filter: state and date range match the file', `TX July ${int(ranged)}`);

  /* ------------------------------------------------------------ search */
  const wantSearch = Number((await truth.one(`SELECT count(*) AS n FROM ${truth.from} WHERE state = 'TX' AND date BETWEEN DATE '2025-07-01' AND DATE '2025-07-31' AND (station_name ILIKE '%AUSTIN%' OR station_id ILIKE '%AUSTIN%')`)).n);
  await click('[data-control=search]');
  await typeText('austin');
  await settleOn(wantSearch, 'the search count');
  check(await matched() === wantSearch && wantSearch > 0, 'search: quick search runs in DuckDB and matches the file', `${wantSearch} rows`);
  const sf = await firstRow();
  check(/AUSTIN/i.test(sf.station_name), 'search: first row is an Austin station', sf.station_name);
  await shot('03-state-date-search');
  for (let i = 0; i < 6; i += 1) await key('Backspace');
  await click('[data-control=clear]');
  await settleOn(total, 'the cleared count');

  /* ------------------------------------------------------------ paging */
  await rowsReady('rows before paging');
  const wheelAt = await centre('.grid-host .lattice [role=grid], .grid-host .lattice');
  for (let i = 0; i < 12; i += 1) {
    await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: wheelAt.x - 100, y: wheelAt.y, deltaX: 0, deltaY: 1500 });
    await sleep(120);
  }
  const paged = await waitFor(`(() => { for (let i = 300; i < 2000; i++) { const r = ${D}.grid.rows.get(i); const d = r && (r.data ?? r); if (d && d.row_id > 200) return true; } return false; })()`, 'later rows to load', 60000);
  check(paged, 'paging: scrolling loads later pages from DuckDB');
  await evaluate('document.querySelector(".grid-host .lattice [role=grid], .grid-host .lattice")');

  /* ---------------------------------------------------------- grouping */
  const byState = await truth.rows(`SELECT state, count(*) AS n, avg(tmax_c) AS hi, avg(prcp_mm) AS rain FROM ${truth.from} GROUP BY state ORDER BY state`);
  await choose('[data-control=group]', 'By state');
  await waitFor(`${D}.grid.rows.count() >= ${byState.length}`, 'the state groups', 90000);
  const groupCount = await evaluate(`${D}.grid.rows.count()`);
  check(groupCount >= byState.length, 'group: the grid is grouped by state', `${int(groupCount)} display rows`);
  await waitFor(`(() => { const r = ${D}.grid.rows.get(0); return r && r.group && r.data && r.data.totals; })()`, 'the first group row');
  const g0 = await evaluate(`(() => { const r = ${D}.grid.rows.get(0); return { state: r.data.state, n: r.leafCount, hi: r.data.totals.tmax_c, rain: r.data.totals.prcp_mm }; })()`);
  check(g0.state === byState[0].state && g0.n === Number(byState[0].n), 'group: first state and its row count match', `${g0.state} ${int(g0.n)}`);
  check(close(g0.hi, byState[0].hi, 1e-6) && close(g0.rain, byState[0].rain, 1e-6), 'group: the averages are the engine\'s', `high ${Number(g0.hi).toFixed(2)} °C`);
  await shot('04-grouped');

  await choose('[data-control=group]', 'By month');
  const byMonth = await truth.rows(`SELECT month, count(*) AS n, avg(tmax_c) AS hi, avg(snow_mm) AS snow FROM ${truth.from} GROUP BY month ORDER BY month`);
  await waitFor(`(() => { const r = ${D}.grid.rows.get(0); return r && r.group && r.data && r.data.month === '01 Jan' && r.data.totals; })()`, 'the month groups', 90000);
  const m0 = await evaluate(`(() => { const r = ${D}.grid.rows.get(0); return { month: r.data.month, n: r.leafCount, hi: r.data.totals.tmax_c, snow: r.data.totals.snow_mm }; })()`);
  check(m0.n === Number(byMonth[0].n) && close(m0.hi, byMonth[0].hi, 1e-6) && close(m0.snow, byMonth[0].snow, 1e-6), 'group: by month, count and averages match the file', `${m0.month} ${int(m0.n)}, high ${Number(m0.hi).toFixed(2)} °C`);
  const monthGroups = await evaluate(`(() => { let c = 0; for (let i = 0; i < Math.min(${D}.grid.rows.count(), 400); i++) { const r = ${D}.grid.rows.get(i); if (r && r.group) c++; } return c; })()`);
  check(monthGroups >= 1, 'group: month groups are drawn', monthGroups);
  await shot('04b-grouped-month');
  await choose('[data-control=group]', 'No');
  await waitFor(`${D}.grid.rows.count() === ${total}`, 'the ungrouped rows', 90000);
  check(await evaluate(`${D}.grid.rows.count()`) === total, 'group: "No grouping" returns the whole file as rows');

  /* ----------------------------------------------------- calendar select */
  await choose('[data-control=station]', 'Phoenix');
  const phx = await truth.one(`SELECT count(*) AS n, max(tmax_c) AS hi FROM ${truth.from} WHERE station_id = 'USW00023183'`);
  await waitFor(`document.querySelector('[data-calendar-note]').textContent.includes('Highest: ${phx.hi} °C')`, 'the Phoenix calendar', 60000);
  const note2 = await evaluate('document.querySelector("[data-calendar-note]").textContent');
  check(note2.includes(`Highest: ${phx.hi} °C`), 'calendar: choosing a station redraws its year', note2);

  /* --------------------------------------------------------- the page */
  await shot('05-final');
  const text = await evaluate('document.body.innerText');
  check(!/\bNaN\b|\bundefined\b|\[object Object\]/.test(text), 'page: no NaN / undefined / [object Object] text');
  const marks = await evaluate('document.querySelectorAll("[class*=watermark]").length');
  const visible = await evaluate('[...document.querySelectorAll("[class*=watermark]")].filter((e) => e.offsetParent !== null && /trial|evaluation|unlicensed/i.test(e.textContent)).length');
  check(marks === 0 || visible === 0, 'page: no licence watermark', `${marks} nodes`);
  check(consoleErrors.length === 0, 'page: 0 console errors', consoleErrors.slice(0, 3).join(' | '));

  /* ----------------------------------------------------------- the wire */
  const tally = served.ranges().files.find((f) => f.path.endsWith(DATA_NAME));
  check(Boolean(tally) && tally.whole === 0, 'wire: no whole-file GET of the Parquet file', tally ? `${tally.whole} whole` : 'no requests');
  check(Boolean(tally) && tally.partial > 0 && tally.partial + tally.head === tally.requests, 'wire: every request for the data was a range read or a size probe', tally ? `${int(tally.partial)} ranges, ${tally.head} HEAD` : '');
  console.log(`Data read: ${int(tally?.partial ?? 0)} range reads, ${((tally?.bytes ?? 0) / 1048576).toFixed(1)} MB of a ${((tally?.size ?? 0) / 1048576).toFixed(1)} MB file`);

  truth.close();
}

try {
  await run();
} catch (error) {
  failures.push(String(error?.stack ?? error));
  notes.push(`  FAIL ${error?.message ?? error}`);
} finally {
  await shutdown();
}

console.log(notes.join('\n'));
console.log(failures.length ? `\n${failures.length} check(s) failed.` : '\nAll checks passed.');
process.exit(failures.length ? 1 : 0);
