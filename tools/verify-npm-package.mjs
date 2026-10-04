/**
 * Verify a TypeScript package as a user installs it: pack it (and the core it plugs into),
 * install the tarballs into an empty project with the package's third-party peers at the
 * versions it is tested against, run the package's own `scripts/package-smoke.mjs`, and
 * check that `require()` exposes the same exports as `import`. A package without
 * third-party peers must install exactly the packed packages and their runtime
 * dependencies.
 *
 * With `--core-floor`, a package built on the core is installed with the published core at
 * the lowest version its peer range allows instead of the packed core, so a release cannot
 * rely on core features its range does not guarantee.
 *
 *   node tools/verify-npm-package.mjs <package-dir> [--core-floor]
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [packageDir, mode, ...extra] = process.argv.slice(2);
if (!packageDir || extra.length > 0 || (mode !== undefined && mode !== '--core-floor')) {
  throw new Error('usage: verify-npm-package.mjs <package-dir> [--core-floor]');
}

const pkg = resolve(packageDir);
const core = resolve(import.meta.dirname, '../adapters/core/typescript');
const manifest = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const { name, peerDependencies = {}, devDependencies = {} } = manifest(pkg);
const coreName = manifest(core).name;
const coreFloor = mode === '--core-floor';
const packed = pkg === core || coreFloor ? [pkg] : [core, pkg];
const packedNames = packed.map((dir) => manifest(dir).name);
const peers = Object.keys(peerDependencies)
  .filter((peer) => !packedNames.includes(peer) && peer !== coreName)
  .map((peer) => `${peer}@${devDependencies[peer] ?? peerDependencies[peer]}`);
const floor = /^\^(\d+\.\d+\.\d+)$/.exec(peerDependencies[coreName] ?? '')?.[1];
if (coreFloor && !floor) {
  throw new Error(`${name} must declare ${coreName} as a peer with a ^x.y.z range`);
}
const coreSpecs = coreFloor ? [`${coreName}@${floor}`] : [];
const project = mkdtempSync(join(tmpdir(), 'audr-verify-npm-package-'));
const run = (command, args, cwd = project) =>
  execFileSync(command, args, { cwd, encoding: 'utf8' });

const installedPackages = () => {
  const modules = join(project, 'node_modules');
  // A scoped package installs as node_modules/@scope/name.
  return readdirSync(modules)
    .filter((entry) => !entry.startsWith('.'))
    .flatMap((entry) =>
      entry.startsWith('@')
        ? readdirSync(join(modules, entry)).map((child) => `${entry}/${child}`)
        : [entry],
    )
    .sort();
};

try {
  const tarballs = packed.map((dir) =>
    join(project, run('npm', ['pack', '--silent', '--pack-destination', project], dir).trim()),
  );
  writeFileSync(join(project, 'package.json'), '{ "private": true, "type": "module" }\n');
  run('npm', [
    'install',
    '--silent',
    '--no-audit',
    '--no-fund',
    ...tarballs,
    ...coreSpecs,
    ...peers,
  ]);

  if (peers.length === 0 && !coreFloor) {
    const expected = [
      ...new Set(
        packed.flatMap((dir) => [
          manifest(dir).name,
          ...Object.keys(manifest(dir).dependencies ?? {}),
        ]),
      ),
    ].sort();
    const installed = installedPackages();
    if (installed.join() !== expected.join()) {
      throw new Error(`expected ${expected.join(', ')}, found: ${installed.join(', ')}`);
    }
  }

  copyFileSync(join(pkg, 'scripts/package-smoke.mjs'), join(project, 'smoke.mjs'));
  run('node', ['smoke.mjs']);

  const esm = run('node', [
    '--input-type=module',
    '-e',
    `console.log(Object.keys(await import('${name}')).sort().join())`,
  ]);
  const cjs = run('node', ['-e', `console.log(Object.keys(require('${name}')).sort().join())`]);
  if (esm !== cjs) throw new Error(`require() exports ${cjs.trim()}, import exports ${esm.trim()}`);

  const installed = [
    ...coreSpecs,
    ...(peers.length === 0 && !coreFloor ? ['exactly its runtime dependencies'] : peers),
  ].join(', ');
  console.log(
    `  ${name} installs with ${installed} and passes its smoke test via import and require`,
  );
} finally {
  rmSync(project, { recursive: true, force: true });
}
