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

const TYPES_ONLY = {
  name: '@openrouter/sdk',
  message: 'Import only types from @openrouter/sdk.',
  allowTypeImports: true,
};

const TYPES_ONLY_SUBPATHS = {
  group: ['@openrouter/sdk/*'],
  message: 'Import only types from @openrouter/sdk.',
  allowTypeImports: true,
};

export default defineConfig(
  workspaceConfig(import.meta.dirname),
  {
    // The package runs wherever the OpenRouter SDK does. `@openrouter/sdk` is a peer
    // dependency, so only its types may be imported; the one Node API used is
    // `AsyncLocalStorage`.
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [TYPES_ONLY],
          patterns: [
            TYPES_ONLY_SUBPATHS,
            {
              regex: '^node:',
              message: 'Only src/attribution.ts may import node:async_hooks.',
            },
          ],
        },
      ],
      'no-restricted-globals': ['error', ...NODE_GLOBALS],
    },
  },
  {
    files: ['src/attribution.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [TYPES_ONLY],
          patterns: [
            TYPES_ONLY_SUBPATHS,
            {
              regex: '^node:(?!async_hooks$)',
              message: 'Only node:async_hooks is allowed.',
            },
          ],
        },
      ],
    },
  },
);
