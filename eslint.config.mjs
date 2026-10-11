import js from '@eslint/js';
import globals from 'globals';
export default [{ ignores: ['**/dist/**', 'node_modules/**', '.agent-runtime/**', '.data/**'] },
  { files: ['services/records/src/**/*.mjs', 'packages/records/src/**/*.mjs', 'scripts/**/*.mjs', 'tests/records*.mjs', 'apps/web/src/production-server.mjs'],
    ...js.configs.recommended, languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
    rules: { 'no-unused-vars': ['error', { ignoreRestSiblings: true, argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }] } }];
