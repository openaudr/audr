/**
 * Fail when the root lockfile resolves `@openaudr/audr` from the registry for any package.
 * A dependent whose range excludes the workspace core's version would otherwise be tested
 * against a published core.
 *
 *   node tools/check-workspace-core.mjs
 */
import { readFileSync } from 'node:fs';

const lockfile = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const unlinked = Object.entries(lockfile.packages)
  .filter(([path, entry]) => path.endsWith('node_modules/@openaudr/audr') && !entry.link)
  .map(([path]) => path);

if (unlinked.length > 0) {
  console.error(`Not linked to the workspace core: ${unlinked.join(', ')}`);
  process.exit(1);
}
