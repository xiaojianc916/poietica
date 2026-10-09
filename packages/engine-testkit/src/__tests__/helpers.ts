import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const made: string[] = []

/** 建一个临时工作区目录；process 退出前由 `bun test` 的 afterAll 清理（见下） */
export async function tempDirWithCleanup(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'poietica-conformance-'))
  made.push(dir)
  return dir
}

process.on('exit', () => {
  for (const dir of made) void rm(dir, { recursive: true, force: true })
})
