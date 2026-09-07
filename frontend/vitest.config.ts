import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    testTimeout: 30000,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', '.next', 'e2e'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/test/**',
        'src/**/*.d.ts',
        'src/app/layout.tsx',
        'src/app/manifest.webmanifest/route.ts',
        'src/proxy.ts',
        'src/types/**',
        // The worker entry point needs a real `Worker` global, which no test
        // environment provides. Everything it delegates to is covered
        // (`document-scan-messages.ts`), and a guard keeps it that thin.
        'src/lib/document-scanner/document-scan.worker.ts',
      ],
      thresholds: {
        branches: 84,
        functions: 87,
        lines: 91,
        statements: 90,
      },
    },
    css: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
