import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { prepareDataRoot } from './data-root'

/*
 * 数据根只有一个来源：main.ts 钉住的 userData。这一层只把它建出来 ——
 * 未发布的软件没有「别处的老数据」要搬，所以这里没有可搬的东西，也守得住
 * 「已经在根里的字节一个都不动」。
 */
const scratch = (): string =>
  join(mkdtempSync(join(tmpdir(), 'poietica-data-root-')), 'nested', 'Poietica')

describe('数据根', () => {
  test('不存在时自己建出来', async () => {
    const root = scratch()

    await prepareDataRoot(root)

    expect(existsSync(root)).toBe(true)
  })

  test('已经存在时不动里面任何一个字节', async () => {
    const root = scratch()

    await prepareDataRoot(root)
    writeFileSync(join(root, 'settings.json'), '{"theme":"dark"}')

    await prepareDataRoot(root)

    expect(readFileSync(join(root, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
  })
})
