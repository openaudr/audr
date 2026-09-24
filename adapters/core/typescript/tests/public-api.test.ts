/**
 * Pins the runtime exports of every entry point. Adding a name is a public API change:
 * make it deliberately and update this test.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import * as file from '../src/file-sink.js';
import * as root from '../src/index.js';
import * as testing from '../src/testing.js';

it('pins the root exports', () => {
  expect(Object.keys(root).sort()).toEqual([
    'AudrError',
    'BatchResult',
    'Client',
    'ConfigurationError',
    'SPEC_VERSION',
    'VERSION',
    'ValidationError',
    'createRecord',
    'decodeRecord',
    'encodeRecord',
    'parseRecord',
    'uuidv7',
    'validate',
  ]);
});

it('pins the audr/file exports', () => {
  expect(Object.keys(file)).toEqual(['FileSink']);
});

it('pins the audr/testing exports', () => {
  expect(Object.keys(testing).sort()).toEqual(['MemorySink', 'assertSinkContract', 'makeRecord']);
});

it('keeps VERSION equal to the package version', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as {
    version: string;
  };
  expect(root.VERSION).toBe(pkg.version);
});

it('keeps every module the root entry point loads free of Node-only imports', () => {
  const src = join(import.meta.dirname, '../src');
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(join(src, file), 'utf8');
    expect(text, file).not.toMatch(/from 'node:/);
    for (const [, local] of text.matchAll(/from '\.\/([\w-]+)\.js'/g)) visit(`${local!}.ts`);
  };
  visit('index.ts');
  expect([...seen].sort()).toEqual(
    readdirSync(src)
      .filter((file) => !['file-sink.ts', 'testing.ts'].includes(file))
      .sort(),
  );
});
