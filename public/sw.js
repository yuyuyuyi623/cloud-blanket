// 最小 Service Worker（2026-11-24）
// 目的 1：满足 Android Chromium（Chrome/Edge）的 PWA 安装性要求——
//        没有带 fetch handler 的 SW，浏览器不认这个站"可安装"，菜单里连
//        「添加到主屏幕」都不会出现（实测 2026-11-24 羽翼真机）。
// 目的 2：接「分享到云朵被子」——用户在通知栏/下载管理器把 zip 分享给本 App 时，
//        浏览器会 POST 到 share_target.action（./share-target）。这里把文件暂存进
//        Cache，然后 303 跳回首页，由页面取走并直接进导入流程（省掉用户找文件）。
//
// 纪律：除上面那个 POST，这里不做任何缓存拦截（cache-first 会把旧 bundle 钉死，
// BYOK 应用也没离线需求），所有请求原样放行，页面永远拿到最新版。

const SHARE_CACHE = 'cb-share'
const SHARE_KEY = 'shared-archive'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

/** 分享动作落点：跟随部署子路径，不写死 /share-target（GitHub Pages 在 /cloud-blanket/ 下） */
const shareActionUrl = () => new URL('share-target', self.registration.scope)

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method === 'POST' && url.pathname === shareActionUrl().pathname) {
    event.respondWith(handleShare(event.request))
    return
  }
  event.respondWith(fetch(event.request))
})

async function handleShare(request) {
  const home = new URL('./', self.registration.scope)
  const done = new URL(home)
  done.searchParams.set('share', '1')
  try {
    const form = await request.formData()
    const file = form.get('file')
    // 分享来的可能是带内容的 File，也可能是空壳；没有内容就当没分享过
    if (file && typeof file === 'object' && typeof file.size === 'number' && file.size > 0) {
      const cache = await caches.open(SHARE_CACHE)
      await cache.put(
        new URL(SHARE_KEY, self.registration.scope),
        new Response(file, {
          headers: {
            // 文件名靠自定义头捎回去：缓存里只存 body，原文件名会丢
            'x-cb-filename': encodeURIComponent(file.name || 'shared-export.zip'),
            'x-cb-type': file.type || 'application/zip',
          },
        })
      )
    }
  } catch (error) {
    // 存不下（超大包 / 配额满）就算了：用户还能在首页手动选文件，别把分享流程变成死路
  }
  return Response.redirect(done.toString(), 303)
}
