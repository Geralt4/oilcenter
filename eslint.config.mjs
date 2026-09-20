import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores(['.next/**', 'node_modules/**', 'data/**', '.cache/**', 'public/**', 'drizzle/**', 'next-env.d.ts', 'Tsakiridis */**']),
  {
    rules: {
      // `_name` marks a value that is destructured only to be left out of the rest object
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
]);
