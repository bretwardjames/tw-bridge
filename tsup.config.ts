import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      cli: 'src/cli.ts',
      'hooks/on-modify': 'src/hooks/on-modify.ts',
    },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    splitting: false,
    clean: true,
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
]);
