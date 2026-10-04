import { defineConfig } from 'eslint/config';
import { workspaceConfig } from '../../../eslint.base.mjs';

const NODE_GLOBALS = [
  'Buffer',
  'process',
  'global',
  'require',
  'module',
  '__dirname',
  '__filename',
  'setImmediate',
  'clearImmediate',
];

export default defineConfig(
  workspaceConfig(import.meta.dirname),
  // Ajv's standalone output; `make schema-check` keeps it current.
  { ignores: ['src/generated-validator.ts'] },
  {
    // The root entry point runs in any modern JavaScript runtime; Node-only code lives
    // behind the `@openaudr/audr/file` and `@openaudr/audr/testing` subpaths.
    files: ['src/**/*.ts'],
    ignores: ['src/file-sink.ts', 'src/testing.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ regex: '^node:', message: 'Node-only code belongs behind a subpath.' }] },
      ],
      'no-restricted-globals': ['error', ...NODE_GLOBALS],
    },
  },
);
