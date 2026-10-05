/**
 * Pins the runtime exports. Adding a name is a public API change: make it deliberately and
 * update this test.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { expect, it } from 'vitest';

import * as root from '../src/index.js';

const SRC = join(import.meta.dirname, '../src');

function emitted(file: string): string {
  return ts.transpileModule(readFileSync(join(SRC, file), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
      verbatimModuleSyntax: true,
    },
    fileName: file,
  }).outputText;
}

it('pins the root exports', () => {
  expect(Object.keys(root).sort()).toEqual([
    'RESPONSE_FAILED_CODE',
    'RESPONSE_INCOMPLETE_CODE',
    'VERSION',
    'instrumentOpenRouter',
    'withAudr',
  ]);
  expect(root.RESPONSE_FAILED_CODE).toBe('OPENROUTER_RESPONSE_FAILED');
  expect(root.RESPONSE_INCOMPLETE_CODE).toBe('OPENROUTER_RESPONSE_INCOMPLETE');
});

it('keeps VERSION equal to the package version', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as {
    version: string;
  };
  expect(root.VERSION).toBe(pkg.version);
});

it('emits no runtime import of @openrouter/sdk, and node: only from attribution.ts', () => {
  const files = readdirSync(SRC).filter((file) => file.endsWith('.ts'));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const js = emitted(file);
    expect(js, file).not.toMatch(/@openrouter\/sdk/);
    const nodeImports = [...js.matchAll(/from ['"](node:[^'"]+)['"]/g)].map((m) => m[1]);
    expect(nodeImports, file).toEqual(file === 'attribution.ts' ? ['node:async_hooks'] : []);
  }
});

it('declares both runtimes as peer and development dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as {
    peerDependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  expect(pkg.dependencies).toBeUndefined();
  expect(Object.keys(pkg.peerDependencies).sort()).toEqual(['@openaudr/audr', '@openrouter/sdk']);
  expect(pkg.peerDependencies['@openrouter/sdk']).toBe('^1.3.8');
  expect(pkg.devDependencies['@openrouter/sdk']).toBe('1.3.8');
  expect(pkg.devDependencies['@openaudr/audr']).toBe(pkg.peerDependencies['@openaudr/audr']);
});
