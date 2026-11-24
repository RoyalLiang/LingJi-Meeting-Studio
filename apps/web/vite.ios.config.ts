import { defineConfig } from 'vite';
import mobile from './vite.mobile.config';

export default defineConfig({
  ...mobile,
  publicDir: false,
  build: {
    ...mobile.build,
    outDir: 'dist-ios',
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: {
      ...mobile.build?.rollupOptions,
      output: { inlineDynamicImports: true },
    },
  },
});
