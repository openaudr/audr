/**
 * Pack the package, install the tarball into an empty project, and prove that it installs
 * only its declared runtime dependencies, none of which brings its own, and loads through
 * both `import` and `require`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const { name, dependencies = {} } = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
) as {
  name: string;
  dependencies?: Record<string, string>;
};
const expected = [name, ...Object.keys(dependencies)].sort();
const project = mkdtempSync(join(tmpdir(), 'audr-verify-'));
const run = (command: string, args: string[]): string =>
  execFileSync(command, args, { cwd: project, encoding: 'utf8' });

const ESM_SMOKE = `
import { Client, createRecord, VERSION } from '${name}';
import { FileSink } from '${name}/file';
import { MemorySink, makeRecord } from '${name}/testing';

const sink = new MemorySink();
const client = new Client(sink, { emitter: { component: 'harness', name: 'verify', version: VERSION } });
const { emitter: _omitted, ...record } = makeRecord();
const result = client.record(createRecord(record));
if (!result.queued) throw new Error('record was not queued');
await client.shutdown();
if (sink.records.length !== 1 || typeof FileSink !== 'function') throw new Error('smoke failed');
`;

const CJS_SMOKE = `
const { validate, VERSION } = require('${name}');
if (validate({}).length === 0 || typeof VERSION !== 'string') throw new Error('smoke failed');
`;

try {
  const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', project], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  writeFileSync(join(project, 'package.json'), '{ "private": true, "type": "module" }\n');
  run('npm', ['install', '--silent', '--no-audit', '--no-fund', join(project, tarball)]);

  // A scoped package installs as node_modules/@scope/name.
  const modules = join(project, 'node_modules');
  const installed = readdirSync(modules)
    .filter((entry) => !entry.startsWith('.'))
    .flatMap((entry) =>
      entry.startsWith('@')
        ? readdirSync(join(modules, entry)).map((child) => `${entry}/${child}`)
        : [entry],
    )
    .sort();
  if (installed.join() !== expected.join()) {
    throw new Error(`expected ${expected.join(', ')}, found: ${installed.join(', ')}`);
  }

  writeFileSync(join(project, 'smoke.mjs'), ESM_SMOKE);
  writeFileSync(join(project, 'smoke.cjs'), CJS_SMOKE);
  run('node', ['smoke.mjs']);
  run('node', ['smoke.cjs']);
  console.log(`  ${tarball} installs ${expected.join(', ')} and loads via import and require`);
} finally {
  rmSync(project, { recursive: true, force: true });
}
