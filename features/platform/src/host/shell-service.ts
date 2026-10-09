import { AppError } from '@poietica/foundation'
import { platformErrors } from '../contract/errors'

/** electron 的 shell 模块里本服务需要的部分（注入，便于测试） */
export interface ShellPort {
  openExternal(url: string): Promise<void>
  openPath(path: string): Promise<string>
  showItemInFolder(path: string): void
  trashItem(path: string): Promise<void>
}

export interface ShellService {
  openExternal(url: string): Promise<void>
  openPath(path: string): Promise<void>
  showInFolder(path: string): void
  trashItem(path: string): Promise<void>
}

const ALLOWED = new Set(['http:', 'https:', 'mailto:'])

export function createShellService(d: { shell: ShellPort; exists(path: string): boolean }): ShellService {
  const fail = (code: string, message: string): never => {
    throw new AppError(code, message)
  }
  const requireExists = (path: string): void => {
    if (!d.exists(path)) fail(platformErrors.path_not_found, `路径不存在：${path}`)
  }
  return {
    async openExternal(url) {
      // 用 new URL 判协议，不用字符串前缀：'file:'、'javascript:'、'data:' 一律拒绝，
      // new URL 抛错也按 url_not_allowed 处理
      const protocol = ((): string => {
        try {
          return new URL(url).protocol
        } catch {
          return fail(platformErrors.url_not_allowed, `地址无法解析：${url}`)
        }
      })()
      if (!ALLOWED.has(protocol)) {
        fail(platformErrors.url_not_allowed, `不允许打开 ${protocol} 链接：${url}`)
      }
      await d.shell.openExternal(url)
    },
    async openPath(path) {
      requireExists(path)
      const error = await d.shell.openPath(path)
      if (error !== '') fail(platformErrors.path_not_found, `无法打开 ${path}：${error}`)
    },
    showInFolder(path) {
      requireExists(path)
      d.shell.showItemInFolder(path)
    },
    async trashItem(path) {
      requireExists(path)
      try {
        await d.shell.trashItem(path)
      } catch (e) {
        fail(platformErrors.trash_failed, `无法移到回收站：${e instanceof Error ? e.message : String(e)}`)
      }
    },
  }
}
