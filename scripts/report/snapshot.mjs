// `--snapshot <out.html>`: the whole report as one self-contained file.
//
// Same page, same app.js. The model, every task's rendered plan and the summary
// are embedded as JSON; the client sees that block and reads from it instead of
// the API, with live updates and ticking switched off. Styles, script and fonts
// are inlined so the file opens from file:// with no server.
//
// Screenshots are NOT embedded (they run to megabytes). They are linked relative
// to the snapshot, so they only resolve when the file sits in the cycle directory.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTaskDetail } from './model.mjs';
import { renderMarkdown } from './markdown.mjs';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), 'ui');

// Keeps embedded text from closing its own <script> or <style> element.
// U+2028 and U+2029 are line terminators inside a script element. They are
// written as char codes so this source file never contains them itself.
const LINE_SEPARATORS = [8232, 8233];
function safeJson(value) {
  let json = JSON.stringify(value).replace(/</g, '\\u003c');
  for (const code of LINE_SEPARATORS) json = json.replaceAll(String.fromCharCode(code), `\\u${code.toString(16)}`);
  return json;
}
const safeScript = (source) => source.replace(/<\/script/gi, '<\\/script');
const safeStyle = (source) => source.replace(/<\/style/gi, '<\\/style');

async function inlineFonts(css) {
  const urls = [...css.matchAll(/url\('(fonts\/[A-Za-z0-9._-]+\.woff2)'\)/g)].map((m) => m[1]);
  let out = css;
  for (const url of new Set(urls)) {
    const data = await readFile(join(UI_DIR, url));
    out = out.replaceAll(`url('${url}')`, `url('data:font/woff2;base64,${data.toString('base64')}')`);
  }
  return out;
}

export async function buildSnapshotHtml({ model, raw }) {
  const [page, css, app, theme] = await Promise.all(
    ['index.html', 'styles.css', 'app.js', 'theme.js'].map((name) => readFile(join(UI_DIR, name), 'utf8')),
  );

  const tasks = {};
  for (const id of Object.keys(model.tasks)) tasks[id] = buildTaskDetail(raw, id);

  let summary = { file: null, html: '', truncated: false };
  if (raw.summaryFile) {
    const text = await readFile(join(raw.cycle.dir, raw.summaryFile), 'utf8').catch(() => '');
    summary = { file: raw.summaryFile, ...renderMarkdown(text) };
  }

  const data = `<script type="application/json" id="snapshot-data">${safeJson({ model, tasks, summary })}</script>`;
  const replaceOnce = (html, needle, value) => {
    if (!html.includes(needle)) throw new Error(`Snapshot template drifted: "${needle}" is missing from index.html.`);
    return html.replace(needle, () => value);
  };

  let html = page;
  html = replaceOnce(html, '<script src="theme.js"></script>', `<script>${safeScript(theme)}</script>`);
  html = replaceOnce(html, '<link rel="stylesheet" href="styles.css">', `<style>${safeStyle(await inlineFonts(css))}</style>`);
  html = replaceOnce(html, '<script type="module" src="app.js"></script>', `${data}\n<script type="module">${safeScript(app)}</script>`);
  return html;
}

export async function writeSnapshot(app, { cycle = 'live', outFile }) {
  let state = await app.getState(cycle);
  if (app.enrich) {
    // Pull request states arrive in the background; a snapshot should include them.
    await app.enrich.settle();
    state = await app.getState(cycle, { force: true });
  }
  const path = resolve(outFile);
  await writeFile(path, await buildSnapshotHtml(state));
  return { path, outsideCycle: dirname(path) !== resolve(state.raw.cycle.dir) };
}
