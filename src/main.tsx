import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import { requestPersistentStorage } from './services/storage.js'
import { trackVisit } from './services/analytics.js'
import './app/theme.css'
import './app/global.css'

ensureKatex()
setupTheme()
void requestPersistentStorage()
trackVisit()

// PWA 安装性：Android Chromium 要求站点有 SW 才算"可安装"（菜单才出现添加到主屏幕）。
// sw.js 只放行请求不缓存；只在 https（线上）注册，本地 http dev 跳过。
// 相对 baseURI：GitHub Pages 等子路径部署下不会指到域名根（写死 /sw.js 会 404）。
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register(new URL('sw.js', document.baseURI)).catch(() => undefined)
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
