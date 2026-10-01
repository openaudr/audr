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
  expect(Object.keys(root).sort()).toEqual(['AudrExporter', 'VERSION']);
});

it('keeps VERSION equal to the package version', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as {
    version: string;
  };
  expect(root.VERSION).toBe(pkg.version);
});

it('emits no runtime import of @mastra/* and no node: imports', () => {
  const files = readdirSync(SRC).filter((file) => file.endsWith('.ts'));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const js = emitted(file);
    expect(js, file).not.toMatch(/from ['"]@mastra\/[^'"]+['"]|require\(['"]@mastra/);
    expect(js, file).not.toMatch(/from ['"]node:[^'"]+['"]/);
  }
});
