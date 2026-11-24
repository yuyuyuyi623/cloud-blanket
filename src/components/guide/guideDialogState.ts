import { create } from 'zustand'

/** 新手指引弹窗的开合状态；入口：首页链接、首启引导、导入流程里的"卡住了？" */
export const useGuideDialog = create(() => ({ open: false }))

export const openGuide = () => useGuideDialog.setState({ open: true })

export const closeGuide = () => useGuideDialog.setState({ open: false })
