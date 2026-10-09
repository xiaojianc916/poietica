import { execFile } from 'node:child_process'
import path from 'node:path'

const TASKKILL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')

/**
 * 杀掉 pid 及其全部子孙进程（taskkill /T /F）。进程已不存在也视为成功。最多等待 5 秒。永不 reject。
 * 为什么不用 child.kill()：Windows 上它只结束直接子进程，omp 的 bash 工具、python 内核等孙进程会成为孤儿。
 */
export function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile(TASKKILL, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }, () => resolve())
  })
}
