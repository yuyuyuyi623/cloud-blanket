/**
 * 「添加到桌面」安装入口。
 *
 * 浏览器事实边界（docs/手机端修复与安装入口方案-2026-11-24.md §三）：
 * - Android Chromium 系：beforeinstallprompt 可捕获，能程序化弹官方安装确认框；
 * - iOS：苹果无任何程序化安装通道，只能给图文步骤（明确不做伪安装）；
 * - 夸克等国产浏览器：事件不一定触发，捕获不到就统一降级图文。
 */

import { create } from 'zustand'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/** 捕获到的安装事件；用掉一次就清空（规范不允许重复 prompt） */
let deferred: BeforeInstallPromptEvent | null = null

const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { standalone?: boolean }) : null

const detectInstalled = (): boolean =>
  typeof window !== 'undefined' &&
  (window.matchMedia('(display-mode: standalone)').matches || nav?.standalone === true)

interface InstallState {
  /** 捕获到 beforeinstallprompt，可以程序化弹官方安装框 */
  available: boolean
  /** 已经以独立窗口（桌面快捷方式/PWA）运行 */
  installed: boolean
}

/** 用 zustand 让设置页的三态入口能跟着事件实时变 */
export const useInstallState = create<InstallState>(() => ({
  available: false,
  installed: typeof window !== 'undefined' ? detectInstalled() : false,
}))

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // 阻止浏览器自带的小横幅：入口收进设置页，主界面保持干净（羽翼拍板）
    event.preventDefault()
    deferred = event as BeforeInstallPromptEvent
    useInstallState.setState({ available: true })
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    useInstallState.setState({ available: false, installed: true })
  })
}

/**
 * 弹官方安装确认框。返回是否安装成功；
 * 没捕获到事件（iOS/夸克等）返回 false，调用方应转图文步骤。
 */
export const promptInstall = async (): Promise<boolean> => {
  const event = deferred
  if (!event) {
    return false
  }
  deferred = null
  useInstallState.setState({ available: false })
  await event.prompt()
  const { outcome } = await event.userChoice
  if (outcome === 'accepted') {
    useInstallState.setState({ installed: true })
  }
  return outcome === 'accepted'
}

/** iOS 判定：给图文步骤选文案用。iPad 未标 iPhone，一并算上 */
export const isIos = (): boolean => /iphone|ipad/i.test(nav?.userAgent ?? '')
