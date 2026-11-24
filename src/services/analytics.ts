// 访问计数 beacon（2026-11-24）
// 隐私口径：只记「发生过一次访问 + 页面路径 + 时间戳」三个匿名事实，
// 不含 Key、聊天内容、设备指纹等任何用户数据。
// 后端：site_events 表，RLS 只允许匿名 INSERT（无 SELECT 权限），计数只能通过管理通道查看。
// 同一浏览器会话（sessionStorage 生命周期）只记一次，刷新不重复计数。
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk'

const cloud = createWorkBuddyCloud({
  endpoint: 'https://cloud-blanket-guide.app.workbuddy.host',
  publishableKey: 'wbpk_MfifDIbs47IQp9O36xBwgN_ON4uC2I5V6wGNGR0L2ge720NxnHh7vtY',
})

const SESSION_KEY = 'cloud-blanket:visit-counted'

export function trackVisit(): void {
  try {
    if (sessionStorage.getItem(SESSION_KEY)) {
      return
    }
    sessionStorage.setItem(SESSION_KEY, '1')
    void cloud.database
      .from('site_events')
      .insert({ event: 'visit', path: location.pathname } as never)
      .then(() => undefined, () => undefined)
  } catch {
    // 统计失败静默，不影响应用任何功能
  }
}
