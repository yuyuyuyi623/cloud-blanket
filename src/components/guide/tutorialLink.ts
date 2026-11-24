// 指引入口的统一跳转：站内图文教程页（public/tutorial/，构建时拷进 dist）。
// 原 GuideDialog 文字版指引已删（2026-11-24 羽翼拍板），站内只留图文一套。
// sharecode 跟随当前访问带上，保证从分享链接打开时教程页也能过鉴权。
// 相对 baseURI 解析：子路径部署（GitHub Pages /cloud-blanket/）下不会指错到域名根。
export function openTutorial(): void {
  try {
    const url = new URL('tutorial/', document.baseURI)
    const share = new URLSearchParams(window.location.search).get('sharecode')
    if (share) {
      url.searchParams.set('sharecode', share)
    }
    window.open(url.toString(), '_blank', 'noopener')
  } catch {
    window.open('tutorial/', '_blank', 'noopener')
  }
}
