import { spawn } from 'node:child_process'
import type { Logger } from '@poietica/foundation'

/** 把 URL 交给系统默认浏览器；命令与 magpie 的 proc.OpenBrowser 一致。 */
export interface BrowserCommand {
  readonly file: string
  readonly args: readonly string[]
}

/**
 * Windows 专用。用 System32 的 rundll32 走 url.dll,FileProtocolHandler，
 * 不经过 cmd / PowerShell，不改变 URL。
 */
export function browserCommand(url: string): BrowserCommand {
  const systemRoot = process.env.SystemRoot
  return {
    file: systemRoot === undefined ? 'rundll32' : `${systemRoot}\\System32\\rundll32.exe`,
    args: ['url.dll,FileProtocolHandler', url],
  }
}

export async function openInSystemBrowser(url: string, logger: Logger): Promise<void> {
  const command = browserCommand(url)
  logger.info('opening system browser', {
    file: command.file,
    host: new URL(url).host,
    urlLength: url.length,
  })
  return await new Promise<void>((resolve, reject) => {
    /*
     * magpie 的浏览器路径也没走 proc.Command，因此没有 CREATE_NO_WINDOW；
     * Node 的 windowsHide 会额外带 SW_HIDE，浏览器窗口可能继承成隐藏，不要传。
     */
    const child = spawn(command.file, [...command.args], { stdio: 'ignore' })
    child.once('error', (error) => {
      logger.warn('系统浏览器启动失败', { host: new URL(url).host, error: String(error) })
      reject(error)
    })
    child.once('spawn', () => {
      resolve()
    })
    child.once('exit', (code, signal) => {
      logger.info('system browser command exited', { code, signal })
    })
  })
}
