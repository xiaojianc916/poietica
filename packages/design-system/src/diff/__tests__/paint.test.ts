import { describe, expect, it } from 'bun:test'
import { computeFile, paint } from '../index'

/*
 * 行带的着色器。
 *
 * 这是那次「diff 一片黑」的回归判据：computeFile 只切行、不认语法，片段的 color 恒为
 * null；不跑着色器，屏幕上整片都是正文色，分不出标识符、字符串与注释。审查面板在
 * worker 里跑 paint()，工具抽屉在主线程跑同一份，两处结果必须一致 —— 所以判据钉在
 * 管线本身，不钉某一处 UI。
 */

/* 一段真代码：一行里切得出多种语法色，才验得动着色器。 */
const CODE = [
  'export function createBridge(): Bridge {',
  '  const resolved = getAgentDir()',
  '  return { host: "local", resolved }',
  '}',
].join('\n')
const CODE_AFTER = CODE.replace(
  '  const resolved = getAgentDir()',
  '  const resolved = getAgentDir()\n  ensureThemeSync()',
)

describe('paint', () => {
  it('正文过了着色器：片段带语法色', async () => {
    const file = computeFile('src/bridge.ts', CODE, CODE_AFTER)
    const before = file.rows.flatMap((row) => row.pieces)

    expect(before.length).toBeGreaterThan(0)
    expect(before.every((piece) => piece.color === null)).toBe(true)

    const painted = await paint([file])
    const added = painted[0]?.rows.find((row) => row.kind === 'added')

    if (added === undefined) {
      throw new Error('着色后的行带里没有 added 行')
    }

    const coloured = added.pieces.filter((piece) => piece.color !== null)

    /* 一行里切出多段、颜色不止一种，才是语法着色而不是整行一个色。 */
    expect(coloured.length).toBeGreaterThan(1)
    expect(new Set(coloured.map((piece) => piece.color?.light)).size).toBeGreaterThan(1)
    /* 切分只是换色：拼回来仍与原文一字不差。 */
    expect(added.pieces.map((piece) => piece.text).join('')).toBe(added.text)
  })

  it('不认识的扩展名原样交回', async () => {
    const file = computeFile('note.unknownext', 'a\nb\n', 'a\nc\n')
    const painted = await paint([file])

    expect(painted[0]?.rows.flatMap((row) => row.pieces).every((piece) => piece.color === null)).toBe(true)
  })
})
