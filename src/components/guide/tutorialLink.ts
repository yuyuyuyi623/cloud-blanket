// 指引入口的统一跳转：站内图文教程页（发布目录 /tutorial/，build-tutorial.py 产物）。
// 原 GuideDialog 文字版指引已删（2026-11-24 羽翼拍板），站内只留图文一套。
// sharecode 跟随当前访问带上，保证从分享链接打开时教程页也能过鉴权。
export function openTutorial(): void {
  try {
    const url = new URL('/tutorial/', window.location.origin)
    const share = new URLSearchParams(window.location.search).get('sharecode')
    if (share) {
      url.searchParams.set('sharecode', share)
    }
    window.open(url.toString(), '_blank', 'noopener')
  } catch {
    window.open('/tutorial/', '_blank', 'noopener')
  }
}
