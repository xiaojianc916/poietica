import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installSessionDirectory, SESSION_DIRECTORY } from './session-directory'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'poietica-session-'))
}

test('内核条目搬进 session，我们的数据一个字不动', () => {
  const root = scratch()

  try {
    mkdirSync(join(root, 'Cache', 'Cache_Data'), { recursive: true })
    writeFileSync(join(root, 'Cache', 'Cache_Data', 'data_0'), 'kernel')
    mkdirSync(join(root, 'Partitions', 'poietica-browser'), { recursive: true })
    writeFileSync(join(root, 'Local State'), 'kernel')
    writeFileSync(join(root, 'ledger.sqlite3'), 'ours')
    mkdirSync(join(root, 'agents'), { recursive: true })
    writeFileSync(join(root, 'agents', 'agents.json'), 'ours')
    /* 数据根里我们不认识的东西：不搬也不删。 */
    writeFileSync(join(root, 'notes.txt'), 'user')

    const session = installSessionDirectory(root)

    expect(session).toBe(join(root, SESSION_DIRECTORY))
    expect(existsSync(join(session, 'Cache', 'Cache_Data', 'data_0'))).toBe(true)
    expect(existsSync(join(session, 'Partitions', 'poietica-browser'))).toBe(true)
    expect(existsSync(join(session, 'Local State'))).toBe(true)
    expect(existsSync(join(root, 'Cache'))).toBe(false)
    expect(existsSync(join(root, 'ledger.sqlite3'))).toBe(true)
    expect(existsSync(join(root, 'agents', 'agents.json'))).toBe(true)
    expect(existsSync(join(root, 'notes.txt'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('第二次启动什么也不做：session 里已有的一份赢', () => {
  const root = scratch()

  try {
    mkdirSync(join(root, 'session', 'Cache'), { recursive: true })
    writeFileSync(join(root, 'session', 'Cache', 'current'), 'new')
    mkdirSync(join(root, 'Cache'), { recursive: true })
    writeFileSync(join(root, 'Cache', 'stale'), 'old')

    installSessionDirectory(root)

    expect(existsSync(join(root, 'session', 'Cache', 'current'))).toBe(true)
    expect(existsSync(join(root, 'session', 'Cache', 'stale'))).toBe(false)
    expect(existsSync(join(root, 'Cache', 'stale'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
