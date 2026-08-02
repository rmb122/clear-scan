import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { viteStaticCopy } from 'vite-plugin-static-copy'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/@techstark/opencv-js/dist/opencv.js',
          dest: 'vendor',
          rename: { stripBase: true },
        },
      ],
    }),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'pwa-192.png', 'pwa-512.png'],
      manifest: {
        name: '清晰扫描',
        short_name: '清晰扫描',
        description: '所有图片都在设备本地处理的证件与文档扫描器',
        theme_color: '#087f5b',
        background_color: '#f7f8f4',
        display: 'standalone',
        start_url: '/',
        lang: 'zh-CN',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/pwa-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        shortcuts: [
          {
            name: '扫描身份证',
            short_name: '身份证',
            url: '/scan/id-card',
            icons: [{ src: '/pwa-192.png', sizes: '192x192' }],
          },
          {
            name: '扫描护照',
            short_name: '护照',
            url: '/scan/passport',
            icons: [{ src: '/pwa-192.png', sizes: '192x192' }],
          },
          {
            name: '扫描文档',
            short_name: '文档',
            url: '/scan/document',
            icons: [{ src: '/pwa-192.png', sizes: '192x192' }],
          },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
        navigateFallback: '/index.html',
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
        globIgnores: ['**/models/**', '**/ort-wasm*.wasm'],
        runtimeCaching: [
          {
            urlPattern: /\/ort-wasm[^/]*\.wasm$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'clear-scan-ort-runtime',
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  optimizeDeps: {
    include: ['onnxruntime-web/wasm', 'onnxruntime-web/webgpu'],
  },
  worker: {
    format: 'es',
  },
})
