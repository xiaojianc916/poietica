import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { adoptDataRoot, LEGACY_DATA_ENTRIES } from './data-root'

/*
 * 搬迁的两条纪律：老数据的字节要真的到新根，新根已经落定的东西**一个字符都不能被覆盖**。
 * 0.4.3 那次更新把用户数据删干净了，这里守的就是那条路。
 */

const workspace = (): { root: string; legacy: string } => {
  const base = mkdtempSync(join(tmpdir(), 'poietica-data-root-'))

  return { root: join(base, 'new'), legacy: join(base, 'old') }
}

describe('老数据根搬迁', () => {
  test('老位置的状态搬进新根，搬完老位置不留副本', async () => {
    const { root, legacy } = workspace()

    mkdirSync(join(legacy, 'agents', 'omp'), { recursive: true })
    writeFileSync(join(legacy, 'settings.json'), '{"theme":"dark"}')
    writeFileSync(join(legacy, 'agents', 'omp', 'config.yml'), 'model: x')
    writeFileSync(join(legacy, 'ledger.sqlite3'), 'db')
    writeFileSync(join(legacy, 'ledger.sqlite3-wal'), 'wal')

    await adoptDataRoot(root, [legacy])

    expect(readFileSync(join(root, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
    expect(readFileSync(join(root, 'agents', 'omp', 'config.yml'), 'utf8')).toBe('model: x')
    /* WAL 三件套一起走：只搬主文件会丢最近一段还没并回去的写入。 */
    expect(readFileSync(join(root, 'ledger.sqlite3-wal'), 'utf8')).toBe('wal')

    expect(existsSync(join(legacy, 'settings.json'))).toBe(false)
    expect(existsSync(join(legacy, 'agents'))).toBe(false)
  })

  test('新根已有的那一项不动：新根赢，老位置留着不覆盖', async () => {
    const { root, legacy } = workspace()

    mkdirSync(root, { recursive: true })
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(root, 'settings.json'), '{"theme":"light"}')
    writeFileSync(join(legacy, 'settings.json'), '{"theme":"dark"}')

    await adoptDataRoot(root, [legacy])

    expect(readFileSync(join(root, 'settings.json'), 'utf8')).toBe('{"theme":"light"}')
    expect(readFileSync(join(legacy, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
  })

  test('搬的是状态那一份清单：日志、缓存与解释器不跟着走', async () => {
    const { root, legacy } = workspace()

    mkdirSync(join(legacy, 'logs'), { recursive: true })
    mkdirSync(join(legacy, 'cache'), { recursive: true })
    mkdirSync(join(legacy, 'tools'), { recursive: true })
    writeFileSync(join(legacy, 'logs', 'app.log'), 'x')

    await adoptDataRoot(root, [legacy])

    expect(LEGACY_DATA_ENTRIES).not.toContain('logs')
    expect(existsSync(join(root, 'logs'))).toBe(false)
    expect(existsSync(join(root, 'tools'))).toBe(false)
    /* 不搬的就不动它：老位置里的东西留给用户自己处置。 */
    expect(existsSync(join(legacy, 'logs', 'app.log'))).toBe(true)
  })

  test('老位置就是新根、或者根本不存在：什么都不发生', async () => {
    const { root, legacy } = workspace()

    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'settings.json'), '{"theme":"dark"}')

    await adoptDataRoot(root, [legacy, root, join(legacy, 'nowhere')])

    expect(existsSync(join(root, 'settings.json'))).toBe(true)
    expect(readFileSync(join(root, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
  })

  test('新数据根不存在时自己建出来', async () => {
    const { root } = workspace()

    await adoptDataRoot(root, [])

    expect(existsSync(root)).toBe(true)
  })
})
