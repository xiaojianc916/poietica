import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AppError } from '@poietica/foundation'
import { expandSkillMessage, preparePrompt } from '../prompt'

/*
 * 12 页 §7.6：SubmitInput → omp 输入的转换（迁移自 legacy provider-input.test.ts）。
 * 这一层是「随消息发的图真的进了模型上下文」的唯一保证 —— 不接它，图片会被整条丢掉。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'poietica-prompt-'))
const png = path.join(dir, 'a.png')
writeFileSync(png, Buffer.from('PNGDATA'))
const txt = path.join(dir, 'b.txt')
writeFileSync(txt, 'hello')

const base = { text: '看这个', files: [], skills: [], deliverAs: 'turn' as const }

describe('preparePrompt', () => {
  test('图片读盘转 base64，带上 mediaType 与路径', () => {
    const prepared = preparePrompt({ ...base, images: [{ path: png, mime: 'image/png' }] }, {})
    expect(prepared.images.length).toBe(1)
    expect(prepared.images[0]?.mediaType).toBe('image/png')
    expect(prepared.images[0]?.base64).toBe(Buffer.from('PNGDATA').toString('base64'))
    expect(prepared.images[0]?.path).toBe(png)
  })

  test('普通文件以 @绝对路径 附在正文后（omp 的文件引用约定）', () => {
    const prepared = preparePrompt({ ...base, images: [], files: [{ path: txt, name: 'b.txt' }] }, {})
    expect(prepared.text).toBe(`看这个\n@${txt}`)
  })

  test('没有文件时正文原样不变', () => {
    const prepared = preparePrompt({ ...base, images: [], files: [] }, {})
    expect(prepared.text).toBe('看这个')
  })

  test('技能在会话里找不到时抛 kernel.not_found（不静默丢掉）', async () => {
    const error = await (async () => {
      try {
        await expandSkillMessage({ ...base, images: [], files: [], skills: ['nope'] }, [], {
          availableSkills: ['other'],
          skillMessage: async () => null,
        })
      } catch (e) {
        return e
      }
      return undefined
    })()
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('kernel.not_found')
  })

  test('技能展开成 skillMessage 的正文块，技能名原样带回', async () => {
    const message = await expandSkillMessage({ ...base, images: [], files: [], skills: ['demo'] }, [], {
      availableSkills: ['demo'],
      skillMessage: async (name, args) => ({ message: `SKILL ${name}: ${args}`, details: { name, args } }),
    })
    expect(message?.content).toEqual([{ type: 'text', text: 'SKILL demo: 看这个' }])
    expect(message?.details).toEqual({ name: 'demo', args: '看这个' })
  })

  test('超过 20 MB 的图片抛 kernel.invalid_params', () => {
    const error = (() => {
      try {
        preparePrompt(
          { ...base, images: [{ path: png, mime: 'image/png' }] },
          {
            statSize: () => 21 * 1024 * 1024,
            readFile: () => Buffer.from('x'),
          },
        )
      } catch (e) {
        return e
      }
      return undefined
    })()
    expect((error as AppError).code).toBe('kernel.invalid_params')
  })
})
