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
  {
    // The package runs wherever the AI SDK does. Only types may be imported from `ai`; the
    // one Node API used is `AsyncLocalStorage`.
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'ai', message: 'Import only types from ai.', allowTypeImports: true }],
          patterns: [
            {
              regex: '^node:',
              message: 'Only src/runs.ts may import node:async_hooks.',
            },
          ],
        },
      ],
      'no-restricted-globals': ['error', ...NODE_GLOBALS],
    },
  },
  {
    files: ['src/runs.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'ai', message: 'Import only types from ai.', allowTypeImports: true }],
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
