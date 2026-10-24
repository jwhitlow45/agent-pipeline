// Suites that run once per backend. npm test runs jj (colocated) and plain git. PIPELINE_TEST_BACKENDS
// narrows or widens a run: a comma-separated list of jj, jj-plain and git.

import { describe } from 'node:test';

export const BACKENDS = (process.env.PIPELINE_TEST_BACKENDS ?? 'jj,git').split(',').map((name) => name.trim()).filter(Boolean);

export function forEachBackend(title, fn) {
  for (const backend of BACKENDS) describe(`${title} (${backend})`, () => fn(backend));
}
