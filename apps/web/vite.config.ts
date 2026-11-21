import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const quickRecord = {
  name: 'quick-record-entry',
  configureServer(server: import('vite').ViteDevServer) {
    server.middlewares.use((request, _response, next) => {
      if (request.url?.split('?')[0] === '/quick-record') request.url = request.url.replace('/quick-record', '/quick-record.html');
      next();
    });
  },
};
export default defineConfig({ plugins: [react(), quickRecord], server: { host: '127.0.0.1', port: 3000, strictPort: true,
  proxy: { '/api': { target: process.env.RECORD_API_URL || 'http://127.0.0.1:3030', changeOrigin: false } } },
  preview: { host: '127.0.0.1', port: 3000 }, build: {
    sourcemap: false,
    rollupOptions: { input: {
      index: fileURLToPath(new URL('index.html', import.meta.url)),
      quickRecord: fileURLToPath(new URL('quick-record.html', import.meta.url)),
    } },
  } });
