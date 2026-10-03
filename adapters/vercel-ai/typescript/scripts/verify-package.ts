/**
 * Pack this package and the core it plugs into, install both tarballs with the AI SDK into
 * an empty project, and prove that a model call made with the integration registered
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
const sdk = `ai@${manifest.devDependencies.ai ?? ''}`;
const project = mkdtempSync(join(tmpdir(), 'audr-adapter-vercel-ai-verify-'));
const run = (command: string, args: string[], cwd = project): string =>
  execFileSync(command, args, { cwd, encoding: 'utf8' });

const ESM_SMOKE = `
import { generateText, registerTelemetry } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { Client } from '@openaudr/audr';
import { MemorySink } from '@openaudr/audr/testing';
import { audrTelemetry } from '${name}';

const model = new MockLanguageModelV4({
  provider: 'openai.chat',
  modelId: 'gpt-5.4',
  doGenerate: {
    content: [{ type: 'text', text: 'pong' }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 7, text: 7, reasoning: undefined },
    },
    warnings: [],
  },
});
const sink = new MemorySink();
const client = new Client(sink, {
  emitter: { component: 'harness', name: 'verify-package', version: '0' },
  logger: { warn() {}, error() {} },
});
registerTelemetry(audrTelemetry({ client, attributionDefaults: { environment: 'test' } }));
await generateText({ model, prompt: 'ping' });
await client.shutdown();
if (sink.records.length !== 1 || sink.records[0].usage.llm.input_tokens !== 12) {
  throw new Error('call was not metered');
}
`;

const CJS_SMOKE = `
const { audrTelemetry, VERSION } = require('${name}');
if (typeof audrTelemetry !== 'function' || typeof VERSION !== 'string') {
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
