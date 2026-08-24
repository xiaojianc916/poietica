import { describe, expect, it } from 'bun:test'
import { parseInstallSource, requiresInstallConfirmation } from './install-source'

describe('parseInstallSource', () => {
  it('Windows 盘符路径是目录，不是 URL', () => {
    expect(parseInstallSource('C:\\plugins\\demo')).toEqual({
      kind: 'directory',
      path: 'C:\\plugins\\demo',
    })
  })

  it('POSIX 路径是目录', () => {
    expect(parseInstallSource('/opt/plugins/demo')).toEqual({
      kind: 'directory',
      path: '/opt/plugins/demo',
    })
  })

  it('仓库根地址落到默认分支', () => {
    expect(parseInstallSource('https://github.com/MoonshotAI/kimi-code')).toEqual({
      kind: 'github',
      owner: 'MoonshotAI',
      repo: 'kimi-code',
      ref: { kind: 'default-branch' },
    })
  })

  it('带斜杠的分支名不会被截断', () => {
    expect(parseInstallSource('https://github.com/a/b/tree/release/1.x')).toEqual({
      kind: 'github',
      owner: 'a',
      repo: 'b',
      ref: { kind: 'tree', ref: 'release/1.x' },
    })
  })

  it('认得 releases/tag', () => {
    expect(parseInstallSource('https://github.com/a/b/releases/tag/v1.2.3')).toEqual({
      kind: 'github',
      owner: 'a',
      repo: 'b',
      ref: { kind: 'release-tag', tag: 'v1.2.3' },
    })
  })

  it('认得 commit', () => {
    expect(parseInstallSource('https://github.com/a/b/commit/deadbeef')).toEqual({
      kind: 'github',
      owner: 'a',
      repo: 'b',
      ref: { kind: 'commit', sha: 'deadbeef' },
    })
  })

  it('剥掉 .git 后缀', () => {
    expect(parseInstallSource('https://github.com/a/b.git')).toEqual({
      kind: 'github',
      owner: 'a',
      repo: 'b',
      ref: { kind: 'default-branch' },
    })
  })

  it('非 GitHub 的直链是压缩包', () => {
    expect(parseInstallSource('https://example.com/demo.zip')).toEqual({
      kind: 'archive',
      url: 'https://example.com/demo.zip',
    })
  })
})

describe('requiresInstallConfirmation', () => {
  it('只有官方来源不需要二次确认', () => {
    expect(requiresInstallConfirmation('kimi-official')).toBe(false)
    expect(requiresInstallConfirmation('curated')).toBe(true)
    expect(requiresInstallConfirmation('third-party')).toBe(true)
  })
})
