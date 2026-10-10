import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: process.env.GITHUB_PAGES_BASE || './',
  plugins: [react(), VitePWA({
    registerType: 'prompt',
    includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png'],
    manifest: {
      name: 'Note — Infinite canvas notes', short_name: 'Note',
      description: 'Your boards, screenshots, and ideas, in one place.',
      theme_color: '#7760d5', background_color: '#faf9f6',
      display: 'standalone', start_url: './', scope: './',
      icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
      ]
    },
    workbox: {
      maximumFileSizeToCacheInBytes: 8000000,
      globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm,gz}'],
      globIgnores: ['**/setup.html'],
      skipWaiting: true,
      clientsClaim: true,
      navigateFallback: 'index.html',
      navigateFallbackDenylist: [/^\/auth\//, /\/setup\.html$/]
    }
  })],
  build: { chunkSizeWarningLimit: 2000 }
});
