import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { AppError } from '@poietica/foundation'
import { createGit } from '@poietica/git'
import { createTestLogger, tempDir } from '@poietica/test-kit'
import { createReviewService } from '../service'

/** 07 页 §10G：在临时目录 `git init` 的真实仓库上跑 status / review / stage / commit。 */

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const gitAvailable = hasGit()
const maybe = gitAvailable ? test : test.skip

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', windowsHide: true })
}

async function repo() {
  const root = await tempDir('review-')
  const cwd = root.path
  git(cwd, ['init', '-q', '--initial-branch=main'])
  git(cwd, ['config', 'user.email', 'test@poietica.local'])
  git(cwd, ['config', 'user.name', 'Poietica Test'])
  git(cwd, ['config', 'commit.gpgsign', 'false'])
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'one\ntwo\nthree\n')
  git(cwd, ['add', 'a.txt'])
  git(cwd, ['commit', '-q', '-m', 'init'])
  const service = createReviewService({
    gitFor: (dir) => createGit({ cwd: dir }),
    logger: createTestLogger(),
  })
  return { root, cwd, service }
}

describe('review 服务（真实临时仓库）', () => {
  maybe('不是仓库的目录：status.isRepo === false，不抛错', async () => {
    const dir = await tempDir('review-plain-')
    const service = createReviewService({
      gitFor: (cwd) => createGit({ cwd }),
      logger: createTestLogger(),
    })
    const status = await service.status(dir.path)
    expect(status.isRepo).toBe(false)
    expect(status.staged).toEqual([])
    expect(status.unstaged).toEqual([])
    await dir.dispose()
  })

  maybe('新建文件：review("HEAD") 列出该文件为未跟踪', async () => {
    const { root, cwd, service } = await repo()
    fs.writeFileSync(path.join(cwd, 'b.txt'), 'x\ny\n')
    const files = await service.review(cwd, 'HEAD')
    const b = files.find((f) => f.path === 'b.txt')
    expect(b?.change).toBe('untracked')
    await root.dispose()
  })

  /*
   * 07 页 §10C：未跟踪文件「行数用文件行数计」。它不在 diff 里，numstat 对它一个字
   * 都不吐，所以这一段是 review 自己数的。
   */
  maybe('未跟踪文件的行数 = 文件自己的行数，不是 0', async () => {
    const { root, cwd, service } = await repo()
    fs.writeFileSync(path.join(cwd, 'three.txt'), 'one\ntwo\nthree\n')
    fs.writeFileSync(path.join(cwd, 'no-newline.txt'), 'one\ntwo')
    const files = await service.review(cwd, 'HEAD')

    const three = files.find((f) => f.path === 'three.txt')
    expect(three?.additions).toBe(3)
    expect(three?.deletions).toBe(0)
    expect(three?.binary).toBe(false)

    /* 末尾没有换行的最后一行也算一行 */
    const noNewline = files.find((f) => f.path === 'no-newline.txt')
    expect(noNewline?.additions).toBe(2)

    await root.dispose()
  })

  maybe('未跟踪的二进制文件不数行（binary: true）', async () => {
    const { root, cwd, service } = await repo()
    fs.writeFileSync(path.join(cwd, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]))
    const files = await service.review(cwd, 'HEAD')
    const blob = files.find((f) => f.path === 'blob.bin')
    expect(blob?.additions).toBe(0)
    expect(blob?.binary).toBe(true)
    await root.dispose()
  })

  maybe('空文件是 0 行（与 git numstat 对空新增文件的口径一致）', async () => {
    const { root, cwd, service } = await repo()
    fs.writeFileSync(path.join(cwd, 'empty.txt'), '')
    const files = await service.review(cwd, 'HEAD')
    const empty = files.find((f) => f.path === 'empty.txt')
    expect(empty?.additions).toBe(0)
    expect(empty?.binary).toBe(false)
    await root.dispose()
  })

  maybe('stage 后 review("index") 里出现该文件', async () => {
    const { root, cwd, service } = await repo()
    fs.writeFileSync(path.join(cwd, 'b.txt'), 'x\n')
    await service.stage(cwd, ['b.txt'])
    const files = await service.review(cwd, 'index')
    expect(files.map((f) => f.path)).toContain('b.txt')
    const status = await service.status(cwd)
    expect(status.staged.map((c) => c.path)).toContain('b.txt')
    await root.dispose()
  })

  maybe('没有暂存内容时 commit(stageAll:false) → nothing_to_commit', async () => {
    const { root, cwd, service } = await repo()
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'changed\n')
    let caught: unknown
    try {
      await service.commit(cwd, 'message', false)
    } catch (e) {
      caught = e
    }
    expect((caught as AppError).code).toBe('review.nothing_to_commit')
    await root.dispose()
  })

  maybe('commit(stageAll:true) 返回新 HEAD 短号；之后 status 干净', async () => {
    const { root, cwd, service } = await repo()
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'changed\n')
    const { commit } = await service.commit(cwd, 'update a', true)
    expect(commit.length).toBeGreaterThan(0)
    const status = await service.status(cwd)
    expect(status.staged).toEqual([])
    expect(status.unstaged).toEqual([])
    await root.dispose()
  })

  maybe('提交信息含引号、换行与 $(rm -rf /)：原样保存，没有命令被执行', async () => {
    const { root, cwd, service } = await repo()
    const message = 'a "quote"\nline2 $(echo pwned) `whoami`'
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'again\n')
    await service.commit(cwd, message, true)
    const subject = git(cwd, ['log', '-1', '--pretty=%B'])
    expect(subject.trimEnd()).toBe(message)
    /* 命令替换没有被执行：git 只把它当文本 */
    expect(subject).toContain('$(echo pwned)')
    await root.dispose()
  })

  maybe('createBranch 已存在的名字 → branch_exists', async () => {
    const { root, cwd, service } = await repo()
    let caught: unknown
    try {
      await service.createBranch(cwd, 'main', null)
    } catch (e) {
      caught = e
    }
    expect((caught as AppError).code).toBe('review.branch_exists')
    await root.dispose()
  })

  maybe('createBranch 新名字后当前分支切换过去', async () => {
    const { root, cwd, service } = await repo()
    const status = await service.createBranch(cwd, 'feature', null)
    expect(status.branch).toBe('feature')
    await root.dispose()
  })

  maybe('switchBranch 切换回来', async () => {
    const { root, cwd, service } = await repo()
    await service.createBranch(cwd, 'feature', null)
    const back = await service.switchBranch(cwd, 'main')
    expect(back.branch).toBe('main')
    await root.dispose()
  })

  maybe('分支名以 - 开头 → 拒绝（不执行 git）', async () => {
    const { root, cwd, service } = await repo()
    let caught: unknown
    try {
      await service.createBranch(cwd, '--force', null)
    } catch (e) {
      caught = e
    }
    expect((caught as AppError).code).toBe('review.git_failed')
    await root.dispose()
  })

  maybe('filePatch：未跟踪文件也能读出补丁（退出码 1 视为成功）', async () => {
    const { root, cwd, service } = await repo()
    fs.writeFileSync(path.join(cwd, 'new.txt'), 'n1\n')
    const patch = await service.filePatch(cwd, 'new.txt', 'HEAD')
    expect(patch).toContain('new.txt')
    await root.dispose()
  })

  maybe('filePatch：已跟踪文件相对 HEAD 的补丁只含那一份文件', async () => {
    const { root, cwd, service } = await repo()
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'one\nTWO\nthree\n')
    const patch = await service.filePatch(cwd, 'a.txt', 'HEAD')
    expect(patch).toContain('a.txt')
    expect(patch).toContain('+TWO')
    await root.dispose()
  })

  maybe('status：分支名、ahead/behind 与两组清单', async () => {
    const { root, cwd, service } = await repo()
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'staged\n')
    await service.stage(cwd, ['a.txt'])
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'staged\nunstaged\n')
    const status = await service.status(cwd)
    expect(status.isRepo).toBe(true)
    expect(status.branch).toBe('main')
    expect(status.staged.map((c) => c.path)).toEqual(['a.txt'])
    expect(status.unstaged.map((c) => c.path)).toEqual(['a.txt'])
    await root.dispose()
  })

  maybe('branches：列出本地分支与当前分支', async () => {
    const { root, cwd, service } = await repo()
    await service.createBranch(cwd, 'other', null)
    const { current, branches } = await service.branches(cwd)
    expect(current).toBe('other')
    expect(branches.map((b) => b.name).sort()).toEqual(['main', 'other'])
    await root.dispose()
  })

  maybe('unstage：取消暂存后回到未暂存组', async () => {
    const { root, cwd, service } = await repo()
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'changed\n')
    await service.stage(cwd, ['a.txt'])
    const status = await service.unstage(cwd, ['a.txt'])
    expect(status.staged).toEqual([])
    expect(status.unstaged.map((c) => c.path)).toEqual(['a.txt'])
    await root.dispose()
  })

  maybe('review 的加减行数来自 numstat', async () => {
    const { root, cwd, service } = await repo()
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'one\nTWO\nthree\nfour\n')
    const files = await service.review(cwd, 'HEAD')
    const a = files.find((f) => f.path === 'a.txt')
    expect(a?.additions).toBe(2)
    expect(a?.deletions).toBe(1)
    await root.dispose()
  })
})
