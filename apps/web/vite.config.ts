import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], server: { host: '127.0.0.1', port: 3000, strictPort: true,
  proxy: { '/api': { target: process.env.RECORD_API_URL || 'http://127.0.0.1:3030', changeOrigin: false } } },
  preview: { host: '127.0.0.1', port: 3000 }, build: { sourcemap: true } });
