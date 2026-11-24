/**
 * 接「分享到云朵被子」暂存的包（配套 public/sw.js 的 SHARE_CACHE）。
 *
 * 为什么需要这一层：手机用户在通知栏/下载管理器里把 zip 分享给本 App，
 * 浏览器只会 POST 到 share_target.action，页面拿不到 File；SW 把 body 存进
 * Cache 再跳回首页，这里把文件取出来交给导入状态机。
 *
 * 取走即删：分享是一次性的，留着下次启动会重复弹导入窗。
 */

const SHARE_CACHE = 'cb-share'
const SHARE_KEY = 'shared-archive'

/** 与 sw.js 里的 key 必须一致：都相对部署根（GitHub Pages 子路径下也是同一个 URL） */
const shareKeyUrl = () => new URL(SHARE_KEY, document.baseURI).toString()

/**
 * 取分享来的压缩包；没有就返回 null。
 * 任何异常都吞掉返回 null——分享是个锦上添花的入口，不能因为它让应用起不来。
 */
export async function takeSharedArchive(): Promise<File | null> {
  if (typeof caches === 'undefined') {
    return null
  }
  try {
    const cache = await caches.open(SHARE_CACHE)
    const key = shareKeyUrl()
    const response = await cache.match(key)
    if (!response) {
      return null
    }
    const blob = await response.blob()
    await cache.delete(key)
    if (!blob.size) {
      return null
    }
    const rawName = response.headers.get('x-cb-filename')
    let name = 'shared-export.zip'
    if (rawName) {
      try {
        name = decodeURIComponent(rawName)
      } catch {
        // 头里编码坏了就用默认名，反正解析只看内容不看名字
      }
    }
    const type = response.headers.get('x-cb-type') || 'application/zip'
    return new File([blob], name, { type })
  } catch {
    return null
  }
}

/** 分享跳回来带的 ?share=1，处理完从地址栏抹掉（避免刷新重复走一遍） */
export function clearShareParam(): void {
  try {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('share')) {
      return
    }
    url.searchParams.delete('share')
    window.history.replaceState(window.history.state, '', url.toString())
  } catch {
    // 地址栏改不动不影响功能
  }
}
