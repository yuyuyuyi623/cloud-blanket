/**
 * 浏览器存储持久化：IndexedDB 里的会话与附件在存储压力下可能被浏览器自动驱逐
 * （"清浏览器数据"之外的隐式清除）。申请持久化存储后，驱逐需用户显式操作。
 * 调用时机：应用启动时一次；结果不阻塞渲染，失败静默（多数旧浏览器不支持）。
 */
export const requestPersistentStorage = async (): Promise<boolean> => {
  if (!navigator.storage?.persist) {
    return false
  }
  try {
    if (await navigator.storage.persisted()) {
      return true
    }
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

/** 存储用量概览（字节）；浏览器不支持时返回 null，供设置页展示 */
export const getStorageEstimate = async (): Promise<{
  usage: number
  quota: number
  persisted: boolean
} | null> => {
  if (!navigator.storage?.estimate) {
    return null
  }
  try {
    const { usage = 0, quota = 0 } = (await navigator.storage.estimate()) ?? {}
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false
    return { usage, quota, persisted }
  } catch {
    return null
  }
}
