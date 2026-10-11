import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3001';
const PROXIED = ['/run', '/tools', '/tasks', '/source', '/loc', '/health', '/models'];

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    // Bind explicitly so a second Vite instance can't silently answer on IPv6.
    host: '127.0.0.1',
    port: Number(process.env.CLIENT_PORT ?? 5173),
    strictPort: true,
    proxy: Object.fromEntries(PROXIED.map((path) => [path, { target: API, changeOrigin: true }])),
  },
  build: { outDir: '../dist/client', emptyOutDir: true },
});
