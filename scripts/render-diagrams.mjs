#!/usr/bin/env node
// Renders every Excalidraw drawing in docs/diagrams/ to docs/images/<name>.png and <name>-dark.png
// at twice its size, with Excalidraw's own renderer and its own dark export, then records in
// docs/images/diagrams.json each drawing's hash, each image's hash, and the renderer that drew them.
// The test in test/diagrams.test.mjs compares all three without a browser, so an edited drawing, a
// changed image, or a changed version or export setting fails until this runs again.
//
// Usage: node scripts/render-diagrams.mjs [name ...]   (no names renders every drawing)
//
// The repository has no dependencies, so the exporter in scripts/diagram-exporter/ is installed
// from its lockfile with npm ci, without install scripts, into a temporary folder on each run. It
// runs only in the Chromium revision the pinned playwright-core names, which this script downloads
// once into its own folder ($DIAGRAM_BROWSERS, else render-diagrams-browsers in the temporary
// folder), never into a shared browser cache and never falling back to the machine's Chrome.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const EXPORTER = join(ROOT, 'scripts', 'diagram-exporter');
export const SOURCES = join(ROOT, 'docs', 'diagrams');
export const IMAGES = join(ROOT, 'docs', 'images');
export const RECORD = join(IMAGES, 'diagrams.json');
export const VERSIONS = JSON.parse(readFileSync(join(EXPORTER, 'package.json'), 'utf8')).dependencies;
// The browser build playwright-core 1.63.0 names in its browsers.json. A different one draws text a
// little differently, so the render refuses to run in any other.
export const BROWSER = { name: 'chromium-headless-shell', revision: '1243' };
export const EXPORT = { scale: 2, padding: 24, background: true };
const BROWSERS = process.env.DIAGRAM_BROWSERS ?? join(tmpdir(), 'render-diagrams-browsers');

export const hashOf = (source) => createHash('sha256').update(source).digest('hex');

// What drew the images: the exporter's versions and lockfile, the browser build, and the export
// settings. A change to any of them can change every image.
export const renderer = () => ({
  versions: VERSIONS,
  lockfile: hashOf(readFileSync(join(EXPORTER, 'package-lock.json'))),
  browser: `${BROWSER.name}-${BROWSER.revision}`,
  export: EXPORT,
});

// Every drawing, named by its file name without the extension, in name order.
export function readDrawings(dir = SOURCES) {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.excalidraw'))
    .sort()
    .map((file) => {
      const source = readFileSync(join(dir, file), 'utf8');
      return { name: basename(file, '.excalidraw'), source, sha256: hashOf(source) };
    });
}

function install(work) {
  for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(EXPORTER, file), join(work, file));
  // esbuild finds its platform binary through an optional dependency, so no install script is needed.
  execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: work, stdio: 'inherit' });
  const pinned = JSON.parse(readFileSync(join(work, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8')).browsers.find((entry) => entry.name === BROWSER.name);
  if (pinned?.revision !== BROWSER.revision) throw new Error(`playwright-core names ${BROWSER.name} revision ${pinned?.revision ?? 'none'}, not ${BROWSER.revision}. Set BROWSER in this script to the revision the pinned playwright-core names, then render every drawing.`);
}

async function bundle(work) {
  writeFileSync(join(work, 'entry.mjs'), [
    "import { exportToBlob, restoreElements } from '@excalidraw/excalidraw';",
    'window.Excalidraw = { exportToBlob, restoreElements };',
  ].join('\n'));
  const esbuild = await import(pathToFileURL(join(work, 'node_modules', 'esbuild', 'lib', 'main.js')).href);
  await esbuild.build({
    entryPoints: [join(work, 'entry.mjs')],
    outfile: join(work, 'bundle.js'),
    bundle: true,
    minify: true,
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'error',
  });
}

async function launch(work) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS;
  if (!existsSync(join(BROWSERS, `${BROWSER.name.replace(/-/g, '_')}-${BROWSER.revision}`))) {
    execFileSync(process.execPath, [join(work, 'node_modules', 'playwright-core', 'cli.js'), 'install', '--only-shell', 'chromium'], { cwd: work, stdio: 'inherit', env: process.env });
  }
  const { chromium } = await import(pathToFileURL(join(work, 'node_modules', 'playwright-core', 'index.mjs')).href);
  return chromium.launch();
}

// Serves the page, the bundle and Excalidraw's fonts from disk, so nothing loads from a CDN.
async function openPage(browser, work) {
  const page = await browser.newPage();
  const assets = join(work, 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod');
  await page.route('http://render.local/**', (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path === '/') {
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><meta charset="utf-8"><script>window.EXCALIDRAW_ASSET_PATH = "http://render.local/";</script><script src="/bundle.js"></script>',
      });
    }
    if (path === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: readFileSync(join(work, 'bundle.js')) });
    const file = join(assets, path);
    if (path.startsWith('/fonts/') && existsSync(file)) return route.fulfill({ contentType: 'font/woff2', body: readFileSync(file) });
    return route.fulfill({ status: 404 });
  });
  await page.goto('http://render.local/');
  return page;
}

// Exports one drawing as a base64 PNG. The dark export inverts the colors the way
// Excalidraw's dark theme does.
function exportPng(page, source, dark) {
  return page.evaluate(async ({ source, dark, scale, padding, background }) => {
    const data = JSON.parse(source);
    const blob = await window.Excalidraw.exportToBlob({
      elements: window.Excalidraw.restoreElements(data.elements, null),
      appState: { ...data.appState, exportBackground: background, exportWithDarkMode: dark },
      files: data.files ?? {},
      exportPadding: padding,
      mimeType: 'image/png',
      getDimensions: (width, height) => ({ width: width * scale, height: height * scale, scale }),
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, { source, dark, scale: EXPORT.scale, padding: EXPORT.padding, background: EXPORT.background });
}

async function main(names) {
  const all = readDrawings();
  const unknown = names.filter((name) => !all.some((d) => d.name === name));
  if (unknown.length) throw new Error(`No drawing named ${unknown.join(', ')} in docs/diagrams/.`);
  const previous = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, 'utf8')) : {};
  // Images from another renderer would sit beside new ones, so a changed renderer renders them all.
  const sameRenderer = JSON.stringify(previous.renderer) === JSON.stringify(renderer());
  if (names.length && !sameRenderer) throw new Error('The renderer changed since the last render, so every image must be drawn again. Run node scripts/render-diagrams.mjs with no names.');
  const drawings = names.length ? all.filter((d) => names.includes(d.name)) : all;

  const work = mkdtempSync(join(tmpdir(), 'render-diagrams-'));
  let browser;
  try {
    install(work);
    await bundle(work);
    browser = await launch(work);
    const page = await openPage(browser, work);
    // The first export loads the fonts. It is thrown away so no image is drawn before they arrive.
    await exportPng(page, drawings[0].source, false);
    for (const { name, source } of drawings) {
      writeFileSync(join(IMAGES, `${name}.png`), Buffer.from(await exportPng(page, source, false), 'base64'));
      writeFileSync(join(IMAGES, `${name}-dark.png`), Buffer.from(await exportPng(page, source, true), 'base64'));
      console.log(`Rendered ${name}, light and dark.`);
    }
  } finally {
    await browser?.close();
    rmSync(work, { recursive: true, force: true });
  }

  // Drawings left out of a partial run keep their entry, and a new one stays unrecorded.
  const image = (file) => (existsSync(join(IMAGES, file)) ? hashOf(readFileSync(join(IMAGES, file))) : null);
  const entry = (d) => ({ source: d.sha256, light: image(`${d.name}.png`), dark: image(`${d.name}-dark.png`) });
  const record = {
    renderer: renderer(),
    drawings: Object.fromEntries(all.map((d) => [d.name, drawings.includes(d) ? entry(d) : previous.drawings?.[d.name] ?? null])),
  };
  writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
