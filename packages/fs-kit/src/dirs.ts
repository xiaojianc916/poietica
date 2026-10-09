import { mkdir, rm } from 'node:fs/promises'
import { isInside } from './paths'

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

/**
 * 递归删除 target，但只允许删除 within 之内的路径（防止 bug 导致删到数据根之外）。
 * target 不存在视为成功。Windows 上文件可能被短暂占用（杀毒软件、索引服务），重试 5 次、每次间隔 100ms。
 */
export async function removeSafe(target: string, o: { within: string }): Promise<void> {
  if (!isInside(o.within, target)) throw new Error(`拒绝删除 ${target}：不在 ${o.within} 之内`)
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
