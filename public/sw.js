// 最小 Service Worker（2026-11-24）
// 唯一目的：满足 Android Chromium（Chrome/Edge）的 PWA 安装性要求——
// 没有带 fetch handler 的 SW，浏览器不认这个站"可安装"，菜单里连
// 「添加到主屏幕」都不会出现（实测 2026-11-24 羽翼真机）。
// 纪律：这里不做任何缓存拦截（cache-first 会把旧 bundle 钉死，BYOK 应用
// 也没离线需求），所有请求原样放行，页面永远拿到最新版。
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request))
})
