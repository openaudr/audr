import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import * as api from '../src/index.js';

it('exports exactly the public runtime names', () => {
  expect(Object.keys(api).sort()).toEqual(['StiggSink', 'VERSION', 'flattenRecord']);
});

it('keeps VERSION equal to package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };

  expect(api.VERSION).toBe(pkg.version);
});
