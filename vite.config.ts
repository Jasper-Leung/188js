import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * 资源一律 inline 呈现，绝不 attachment。
 *
 * `Content-Disposition: attachment` 是浏览器（以及挂在浏览器上的
 * 下载管理器）判定"这是一次下载"的**头号信号**。游戏资源没有一个
 * 是给人下载的，所以显式声明 inline：装了 IDM 之类的机器就不会
 * 每加载一条 .glb / .ogg 就弹一次下载框。
 *
 * 另一头是 nosniff：禁止 MIME 嗅探，让服务端声明的类型说了算。
 * 两条一起上，才是把"游戏资源"和"下载"这两件事在协议层彻底分开。
 */
const ASSET_HEADERS = {
  'Content-Disposition': 'inline',
  'X-Content-Type-Options': 'nosniff',
};

// 低配优先的构建配置：
// - target 降到 es2019，产物不依赖老机器没有的语法特性
// - 不做代码分割（避免首屏多余的往返），单包加载
// - 显式关掉 legacy 与 polyfill，three 自己不需要
export default defineConfig({
  base: './',
  // `wrangler deploy` 会来改这个文件，找不到 `plugins` 数组就直接报错退出：
  //   "Cannot modify Vite config: could not find a valid plugins array."
  // 哪怕一个插件都没有，这个键也必须在。
  //
  // 它**一直是空的，而且这是有意的**。官方模板会往这里塞
  // `@cloudflare/vite-plugin`，那是为了让 `vite dev` 能把请求送进 workerd
  // 预览 Worker。本项目一行服务端代码都没有，wrangler.jsonc 也没有 `main`，
  // 所以没有请求会进到 Worker 里——插件在这里没有任何作用，
  // 却会让 `vite dev` 整个跑在 workerd 上：three.js 的 HMR 变慢，
  // WebGL 上下文能不能在 isolate 里正常拿，不该由日常开发来赌。
  //
  // 需要在 workerd 里试跑时用 `npm run preview:cf`（走 wrangler dev，
  // 不经过 vite，也就不碰这个文件）。
  plugins: [],
  build: {
    target: 'es2019',
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    // 音频是独立资源，不该被内联进 JS
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: undefined,
        inlineDynamicImports: true,
      },
    },
    reportCompressedSize: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: false,
    headers: ASSET_HEADERS,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    headers: ASSET_HEADERS,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
