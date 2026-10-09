import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export interface TempDir {
  /** 绝对路径（已解析 8.3 短文件名，便于与其它路径比较） */
  readonly path: string
  dispose(): Promise<void>
}

/** 创建临时目录。用完必须 await dispose()（Windows 上文件占用时自动重试） */
export async function tempDir(prefix = 'poietica-test-'): Promise<TempDir> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)))
  return {
    path: dir,
    dispose: () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  }
}
