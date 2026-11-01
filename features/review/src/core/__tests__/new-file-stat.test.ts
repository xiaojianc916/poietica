import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parseUnifiedPatch } from '@poietica/design-system/diff'
import { createGit } from '@poietica/git'
import { createTestLogger, tempDir } from '@poietica/test-kit'
import { createReviewService } from '../service'

/* 真实仓库走一遍新增文件：清单的 +N、补丁的 +N、解析出来的 +N 必须是同一个数。
 * 这是用户看到「新增几百行却显示 +0」那条链路的端到端判据。 */

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const maybe = hasGit() ? test : test.skip

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', windowsHide: true })
}

maybe('新增 300 行文件：清单、补丁与解析三处都是 +300 −0', async () => {
  const root = await tempDir('review-stat-')
  const cwd = root.path
  try {
    git(cwd, ['init', '-q', '--initial-branch=main'])
    git(cwd, ['config', 'user.email', 'test@poietica.local'])
    git(cwd, ['config', 'user.name', 'Poietica Test'])
    git(cwd, ['config', 'commit.gpgsign', 'false'])
    fs.writeFileSync(path.join(cwd, 'seed.txt'), 'seed\n')
    git(cwd, ['add', 'seed.txt'])
    git(cwd, ['commit', '-q', '-m', 'init'])

    const lines = Array.from({ length: 300 }, (_, index) => `line ${String(index + 1)}`)
    fs.writeFileSync(path.join(cwd, 'fresh.ts'), `${lines.join('\n')}\n`)

    const service = createReviewService({ gitFor: (dir) => createGit({ cwd: dir }), logger: createTestLogger() })
    const files = await service.review(cwd, 'HEAD')
    const listed = files.find((file) => file.path === 'fresh.ts')
    expect(listed?.additions).toBe(300)
    expect(listed?.deletions).toBe(0)
    expect(listed?.change).toBe('untracked')

    const patch = await service.filePatch(cwd, 'fresh.ts', 'HEAD')
    const [parsed] = parseUnifiedPatch(patch, false)
    expect(parsed?.stat).toEqual({ added: 300, removed: 0 })
    expect(parsed?.path).toBe('fresh.ts')
    expect(parsed?.rows.filter((row) => row.kind === 'added')).toHaveLength(300)
  } finally {
    await root.dispose()
  }
})
