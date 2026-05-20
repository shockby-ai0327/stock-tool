import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  base: '/stock-tool/',  // GitHub Pages 子路徑
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2020',
    minify: 'esbuild',
    rollupOptions: {
      output: {
        manualChunks: {
          'firebase': ['firebase/app', 'firebase/auth', 'firebase/firestore'],
          'charts':   ['lightweight-charts'],
        },
      },
    },
  },
  server: {
    port: 5173,
    open: true,
  },
});
