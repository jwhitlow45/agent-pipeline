// Fails when an Excalidraw drawing in docs/diagrams/ changed and its images were not rendered again,
// when an image changed by itself, or when the renderer (its versions, lockfile, browser build or
// export settings) changed since the last render. Needs no browser: it only compares hashes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IMAGES, RECORD, hashOf, readDrawings, renderer } from '../scripts/render-diagrams.mjs';

const record = JSON.parse(readFileSync(RECORD, 'utf8'));
const recorded = record.drawings;

test('there are drawings to check', () => {
  assert.ok(readDrawings().length > 0, 'docs/diagrams/ has no .excalidraw files');
});

test('every drawing has both images', () => {
  for (const { name } of readDrawings()) {
    assert.ok(existsSync(join(IMAGES, `${name}.png`)), `${name}.png is missing`);
    assert.ok(existsSync(join(IMAGES, `${name}-dark.png`)), `${name}-dark.png is missing`);
  }
});

test('every image was rendered from the current drawing', () => {
  for (const { name, sha256 } of readDrawings()) {
    assert.equal(recorded[name]?.source, sha256, `${name}: docs/diagrams/${name}.excalidraw changed, run node scripts/render-diagrams.mjs ${name}`);
  }
});

// PA-67: an image reverted or edited by hand no longer matches what the render wrote.
test('every image is the one the render wrote', () => {
  for (const { name } of readDrawings()) {
    assert.equal(hashOf(readFileSync(join(IMAGES, `${name}.png`))), recorded[name]?.light, `${name}.png is not the image the render wrote. Run node scripts/render-diagrams.mjs ${name}`);
    assert.equal(hashOf(readFileSync(join(IMAGES, `${name}-dark.png`))), recorded[name]?.dark, `${name}-dark.png is not the image the render wrote. Run node scripts/render-diagrams.mjs ${name}`);
  }
});

// PA-67, PA-68: a new exporter version, lockfile, browser build or export setting can change every image.
test('the images were drawn by the renderer the script pins now', () => {
  assert.deepEqual(record.renderer, renderer(), 'The renderer changed since the last render. Run node scripts/render-diagrams.mjs with no names.');
});

test('the record lists no drawing that was removed', () => {
  const names = readDrawings().map((d) => d.name);
  assert.deepEqual(Object.keys(recorded).sort(), names.sort());
});

test('hashing is stable for a known string', () => {
  assert.equal(hashOf('a'), 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
});
