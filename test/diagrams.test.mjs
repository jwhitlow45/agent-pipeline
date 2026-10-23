// Fails when an Excalidraw drawing in docs/diagrams/ changed and its images were not rendered again.
// Needs no browser: it only compares source hashes and checks that the image files exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IMAGES, RECORD, hashOf, readDrawings } from '../scripts/render-diagrams.mjs';

const recorded = JSON.parse(readFileSync(RECORD, 'utf8')).drawings;

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
    assert.equal(recorded[name], sha256, `${name}: docs/diagrams/${name}.excalidraw changed, run node scripts/render-diagrams.mjs ${name}`);
  }
});

test('the record lists no drawing that was removed', () => {
  const names = readDrawings().map((d) => d.name);
  assert.deepEqual(Object.keys(recorded).sort(), names.sort());
});

test('hashing is stable for a known string', () => {
  assert.equal(hashOf('a'), 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
});
