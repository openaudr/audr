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
  name: 'merge-gateway-sdk',
  message: 'Import only types from merge-gateway-sdk.',
  allowTypeImports: true,
};

export default defineConfig(
  workspaceConfig(import.meta.dirname),
  {
    // The package runs wherever the Merge Gateway SDK does. `merge-gateway-sdk` is an
    // optional peer dependency, so only its types may be imported; the one Node API used is
    // `AsyncLocalStorage`.
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [TYPES_ONLY],
          patterns: [
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
