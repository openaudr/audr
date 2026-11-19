/**
 * Write `src/version.ts` from the `version` in `package.json` of the current directory.
 * Each TypeScript package runs it as its `version` lifecycle script, so
 * `npm version X.Y.Z --no-git-tag-version --workspace <package-dir>` updates both files.
 *
 *   node ../../../tools/write-version.mjs   (from a package directory)
 */
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
if (typeof version !== 'string' || version === '') {
  console.error('package.json: no version');
  process.exit(1);
}

writeFileSync(
  'src/version.ts',
  `/** This package's release, generated from \`package.json\` by \`npm version\`. Do not edit. */\n` +
    `export const VERSION = '${version}';\n`,
);
