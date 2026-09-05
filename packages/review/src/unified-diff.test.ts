import { describe, expect, test } from 'bun:test'

import { computeFile, diffStatOf, parseUnifiedPatch } from './unified-diff'

/* 两个渲染器照同一份行模型画，所以这里钉住的是模型本身，不是某一处 UI。 */

const PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,7 +1,7 @@',
  ' one',
  ' two',
  ' three',
  '-const value = 1',
  '+const value = 2',
  ' four',
  ' five',
  ' six',
  'diff --git a/logo.png b/logo.png',
  'index 3333333..4444444 100644',
  'Binary files a/logo.png and b/logo.png differ',
  '',
].join('\n')

const WHOLE = [
  'diff --git a/many.txt b/many.txt',
  '--- a/many.txt',
  '+++ b/many.txt',
  '@@ -1,12 +1,12 @@',
  ' 1',
  ' 2',
  ' 3',
  ' 4',
  ' 5',
  ' 6',
  ' 7',
  ' 8',
  '-9',
  '+nine',
  ' 10',
  ' 11',
  ' 12',
  '',
].join('\n')

describe('parseUnifiedPatch', () => {
  test('一节一处改动：路径、账目与行号都跟着补丁走', () => {
    const [file, binary] = parseUnifiedPatch(PATCH, true)

    expect(file?.path).toBe('src/app.ts')
    expect(file?.stat).toEqual({ added: 1, removed: 1 })
    expect(file?.rows.map((row) => row.kind)).toEqual([
      'context',
      'context',
      'context',
      'removed',
      'added',
      'context',
      'context',
      'context',
    ])
    expect(file?.rows.map((row) => row.number)).toEqual([1, 2, 3, 4, 4, 5, 6, 7])
    expect(binary?.path).toBe('logo.png')
    expect(binary?.binary).toBe(true)
    expect(binary?.rows).toHaveLength(0)
  })

  test('词级强调只是切分：拼回来与整行一字不差', () => {
    const row = parseUnifiedPatch(PATCH, true)[0]?.rows[3]

    expect(row?.pieces.map((piece) => piece.text).join('')).toBe(row?.text)
    expect(row?.pieces.some((piece) => piece.emphasis)).toBe(true)
  })

  test('整份文件回来时，折叠带带着折起来的行', () => {
    const gap = parseUnifiedPatch(WHOLE, false)[0]?.rows[0]

    expect(gap?.kind).toBe('gap')
    expect(gap?.lines).toBe(5)
    expect(gap?.hidden).toHaveLength(5)
    expect(gap?.hidden[0]?.number).toBe(1)
  })

  test('一批改动的账是每一处的和', () => {
    expect(diffStatOf(parseUnifiedPatch(PATCH, false))).toEqual({ added: 1, removed: 1 })
    expect(diffStatOf([])).toBeNull()
  })
})

describe('computeFile', () => {
  test('只带 3 行上下文时，前面那些行是一条展不开的折叠带', () => {
    const before = Array.from({ length: 20 }, (_, index) => String(index + 1)).join('\n')
    const after = before.replace('\n10\n', '\nten\n')
    const file = computeFile('many.txt', before, after)
    const gap = file.rows[0]

    expect(file.stat).toEqual({ added: 1, removed: 1 })
    expect(gap?.kind).toBe('gap')
    expect(gap?.lines).toBe(6)
    expect(gap?.hidden).toHaveLength(0)
  })
})
