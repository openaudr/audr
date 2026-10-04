import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import { importX } from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

// ESLint settings shared by every TypeScript package; each package's eslint.config.js
// passes its own directory and adds its own rules.
export const workspaceConfig = (packageDir) =>
  defineConfig(
    {
      // The smoke test is plain JavaScript run inside the empty project
      // tools/verify-npm-package.mjs installs the tarball into.
      ignores: [
        'dist/**',
        'coverage/**',
        'node_modules/**',
        'eslint.config.js',
        'scripts/package-smoke.mjs',
      ],
    },
    js.configs.recommended,
    tseslint.configs.strictTypeChecked,
    tseslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir: packageDir,
        },
      },
      rules: {
        '@typescript-eslint/explicit-module-boundary-types': 'error',
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { fixStyle: 'inline-type-imports' },
        ],
        '@typescript-eslint/switch-exhaustiveness-check': [
          'error',
          { requireDefaultForNonUnion: true },
        ],
        '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
        '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
        // A package writes diagnostics only through the caller's `logger`.
        'no-console': 'error',
      },
    },
    {
      // Workspace hoisting makes undeclared dependencies importable; check runtime and type
      // imports against the package's own manifest.
      files: ['src/**/*.ts'],
      plugins: { 'import-x': importX },
      rules: {
        'import-x/no-extraneous-dependencies': [
          'error',
          { devDependencies: false, includeTypes: true, packageDir },
        ],
      },
    },
    {
      files: ['examples/**/*.ts', 'scripts/**/*.ts'],
      rules: { 'no-console': 'off' },
    },
    {
      files: ['tests/**/*.ts', '*.config.ts'],
      rules: {
        'no-console': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/explicit-module-boundary-types': 'off',
      },
    },
  );
