#!/usr/bin/env node
// Renders every Excalidraw drawing in docs/diagrams/ to docs/images/<name>.png and <name>-dark.png
// at twice its size, with Excalidraw's own renderer and its own dark export, then records each
// drawing's hash in docs/images/diagrams.json. The test in test/diagrams.test.mjs compares those
// hashes, so an edited drawing fails until this runs again.
//
// Usage: node scripts/render-diagrams.mjs [name ...]   (no names renders every drawing)
//
// The repository has no dependencies, so the exporter is installed at pinned versions into a
// temporary folder on each run. It runs in Playwright's Chromium when that is installed
// (npx playwright@<the playwright-core version below> install chromium), and in Google Chrome otherwise.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VERSIONS = {
  '@excalidraw/excalidraw': '0.18.1',
  react: '19.2.8',
  'react-dom': '19.2.8',
  esbuild: '0.28.2',
  'playwright-core': '1.63.0',
};
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCES = join(ROOT, 'docs', 'diagrams');
export const IMAGES = join(ROOT, 'docs', 'images');
export const RECORD = join(IMAGES, 'diagrams.json');
const SCALE = 2;
const PADDING = 24;

export const hashOf = (source) => createHash('sha256').update(source).digest('hex');

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
  writeFileSync(join(work, 'package.json'), '{"private": true}\n');
  const specs = Object.entries(VERSIONS).map(([name, version]) => `${name}@${version}`);
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', ...specs], { cwd: work, stdio: 'inherit' });
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
  const { chromium } = await import(pathToFileURL(join(work, 'node_modules', 'playwright-core', 'index.mjs')).href);
  try {
    return await chromium.launch();
  } catch {
    try {
      return await chromium.launch({ channel: 'chrome' });
    } catch (error) {
      throw new Error(`No browser to render with. Install Google Chrome, or run npx playwright@${VERSIONS['playwright-core']} install chromium.\n${error.message}`);
    }
  }
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
  return page.evaluate(async ({ source, dark, scale, padding }) => {
    const data = JSON.parse(source);
    const blob = await window.Excalidraw.exportToBlob({
      elements: window.Excalidraw.restoreElements(data.elements, null),
      appState: { ...data.appState, exportBackground: true, exportWithDarkMode: dark },
      files: data.files ?? {},
      exportPadding: padding,
      mimeType: 'image/png',
      getDimensions: (width, height) => ({ width: width * scale, height: height * scale, scale }),
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, { source, dark, scale: SCALE, padding: PADDING });
}

async function main(names) {
  const all = readDrawings();
  const unknown = names.filter((name) => !all.some((d) => d.name === name));
  if (unknown.length) throw new Error(`No drawing named ${unknown.join(', ')} in docs/diagrams/.`);
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

  // Drawings left out of a partial run keep their recorded hash, and a new one stays unrecorded.
  const previous = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, 'utf8')).drawings ?? {} : {};
  const rendered = Object.fromEntries(drawings.map((d) => [d.name, d.sha256]));
  const record = {
    excalidraw: VERSIONS['@excalidraw/excalidraw'],
    drawings: Object.fromEntries(all.map((d) => [d.name, rendered[d.name] ?? previous[d.name] ?? null])),
  };
  writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
