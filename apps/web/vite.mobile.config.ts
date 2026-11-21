import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  publicDir: 'public',
  build: {
    outDir: 'dist-mobile',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        mobileApp: fileURLToPath(new URL('mobile-app.html', import.meta.url)),
      },
    },
  },
});
