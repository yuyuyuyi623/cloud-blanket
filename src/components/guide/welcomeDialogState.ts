import { create } from 'zustand'

/** 首启欢迎引导的开合状态；入口：无 Key 访客点「随便聊聊」（不再挂载即弹） */
export const useWelcomeDialog = create(() => ({ open: false }))

export const openWelcome = () => useWelcomeDialog.setState({ open: true })
export const closeWelcome = () => useWelcomeDialog.setState({ open: false })
