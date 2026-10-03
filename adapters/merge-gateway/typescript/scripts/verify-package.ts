/**
 * Pack this package and the core it plugs into, install both tarballs with the Gateway SDK
 * into an empty project, and prove that a call made through the instrumented client
 * reaches a `Client` as one record, loaded through both `import` and `require`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const core = join(root, '../../core/typescript');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string;
  devDependencies: Record<string, string>;
};
const name = manifest.name;
const sdk = `merge-gateway-sdk@${manifest.devDependencies['merge-gateway-sdk'] ?? ''}`;
const project = mkdtempSync(join(tmpdir(), 'audr-adapter-merge-gateway-verify-'));
const run = (command: string, args: string[], cwd = project): string =>
  execFileSync(command, args, { cwd, encoding: 'utf8' });

const ESM_SMOKE = `
import { Client } from '@openaudr/audr';
import { MemorySink } from '@openaudr/audr/testing';
import { instrumentMergeGateway } from '${name}';
import { MergeGateway } from 'merge-gateway-sdk';

globalThis.fetch = () =>
  Promise.resolve(
    Response.json({
      id: 'resp_1',
      object: 'response',
      created_at: new Date().toISOString(),
      model: 'openai/gpt-5.4',
      vendor: 'openai',
      output: [],
      usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19, cost: 0.0001 },
    }),
  );
const sink = new MemorySink();
const client = new Client(sink, { logger: { warn() {}, error() {} } });
const gateway = instrumentMergeGateway(new MergeGateway({ apiKey: 'mg_test' }), {
  client,
  attributionDefaults: { environment: 'test' },
});
if (!(gateway instanceof MergeGateway)) throw new Error('facade is not a MergeGateway');
await gateway.responses.create({ model: 'openai/gpt-5.4', input: 'ping' });
await client.shutdown();
if (sink.records.length !== 1 || sink.records[0].usage.llm.input_tokens !== 12) {
  throw new Error('call was not metered');
}
`;

const CJS_SMOKE = `
const { instrumentMergeGateway, VERSION } = require('${name}');
if (typeof instrumentMergeGateway !== 'function' || typeof VERSION !== 'string') {
  throw new Error('smoke failed');
}
`;

const pack = (dir: string): string =>
  join(project, run('npm', ['pack', '--silent', '--pack-destination', project], dir).trim());

try {
  const tarballs = [pack(core), pack(root)];
  writeFileSync(join(project, 'package.json'), '{ "private": true, "type": "module" }\n');
  run('npm', ['install', '--silent', '--no-audit', '--no-fund', ...tarballs, sdk]);
  writeFileSync(join(project, 'smoke.mjs'), ESM_SMOKE);
  writeFileSync(join(project, 'smoke.cjs'), CJS_SMOKE);
  run('node', ['smoke.mjs']);
  run('node', ['smoke.cjs']);
  console.log(
    `  installs ${name} with the packed core and ${sdk}, and meters via import and require`,
  );
} finally {
  rmSync(project, { recursive: true, force: true });
}
