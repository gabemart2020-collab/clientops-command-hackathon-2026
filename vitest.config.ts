import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'packages/*/tests/**/*.test.ts',
      'services/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
    ],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './apps/web/src'),
      '@clientops/contracts': resolve(
        __dirname,
        './packages/contracts/src/index.ts',
      ),
      '@clientops/domain': resolve(__dirname, './packages/domain/src/index.ts'),
      '@clientops/data': resolve(__dirname, './packages/data/src/index.ts'),
      '@clientops/agent': resolve(__dirname, './packages/agent/src/index.ts'),
      '@clientops/policy': resolve(__dirname, './packages/policy/src/index.ts'),
      '@clientops/audit': resolve(__dirname, './packages/audit/src/index.ts'),
    },
  },
});
