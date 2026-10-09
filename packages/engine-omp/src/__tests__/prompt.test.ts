import { describe, expect, test } from 'bun:test'
import type { SubmitInput } from '@poietica/engine'
import { AppError } from '@poietica/foundation'
import { type ExpandSkillOptions, expandSkillMessage, preparePrompt } from '../prompt'

/*
 * SubmitInput → omp 输入（12 页 §7.6、§12.3 的去向表：迁移自 legacy provider-input.test.ts
 * 与 live-image-attachments.test.ts 的输入那一半、skill-turn.test.ts 的 args 那一格）。
 *
 * legacy 的前提是「线上来的每一格都可能缺席、可能是 null」，所以判据是逐格钉：不炸、不编空壳。
 * 新树的输入面收窄了一档（SubmitInput 的 images / files / skills 都是数组，缺席就是空数组），
 * 于是同一份判据落在这里的两件事上：**每一格都可以是空**，以及**没给的东西不编**。
 *
 * legacy 的 provider 定义那几条（ALL_NULL 不炸、空档位表不算有档位、界面 api 取值对齐上游、
 * 空显示名不算名字）在新树里换了落点：provider 定义现在是 features/models 的 CustomProviderDef
 * 契约（07 页 §6B 的 zod：api 只能是三种、models 至少一条、baseUrl 必须是 http(s)），
 * 单测在 ports/__tests__/models-file.test.ts。契约已经把它挡在门外，所以这里不再复刻一份。
 *
 * 这里不起进程、不碰磁盘：读文件与 stat 都是注入的。
 */
const INPUT: SubmitInput = {
  text: '这是什么',
  images: [],
  files: [],
  skills: [],
  deliverAs: 'turn',
}

function options(over: Partial<Parameters<typeof preparePrompt>[1]> = {}) {
  return {
    ...over,
  }
}

/** 技能展开那一半的可注入面（与 preparePrompt 分开：一个同步、一个要读盘） */
function skillOptions(over: Partial<ExpandSkillOptions> = {}): ExpandSkillOptions {
  return {
    availableSkills: [] as readonly string[],
    skillMessage: async () => null,
    ...over,
  }
}

function codeOf(error: unknown): string {
  return error instanceof AppError ? error.code : '不是 AppError'
}

describe('preparePrompt：图片', () => {
  test('超过 20 MB 的图片拒收，且不去读它', () => {
    let read = 0
    const input: SubmitInput = {
      ...INPUT,
      images: [{ path: 'C:/tmp/huge.png', mime: 'image/png' }],
    }
    const error = (() => {
      try {
        preparePrompt(
          input,
          options({
            statSize: () => 20 * 1024 * 1024 + 1,
            readFile: () => {
              read += 1
              return Buffer.from('')
            },
          }),
        )
        return undefined
      } catch (caught) {
        return caught
      }
    })()
    expect(codeOf(error)).toBe('kernel.invalid_params')
    // 大小先判：读一个 25MB 的文件再拒，等于白读一遍
    expect(read).toBe(0)
  })

  test('刚好 20 MB 收下：上限是「超过」才拒', () => {
    const prepared = preparePrompt(
      { ...INPUT, images: [{ path: 'C:/tmp/ok.png', mime: 'image/png' }] },
      options({ statSize: () => 20 * 1024 * 1024, readFile: () => Buffer.from('pixel') }),
    )
    expect(prepared.images).toEqual([
      { mediaType: 'image/png', base64: Buffer.from('pixel').toString('base64'), path: 'C:/tmp/ok.png' },
    ])
  })

  test('内容类型取线上那一格 mime，不按扩展名反推', () => {
    // 剪贴板粘贴的图叫 pasted-<uuid>，没有扩展名；按扩展名反推会把它说成 application/octet-stream
    const prepared = preparePrompt(
      { ...INPUT, images: [{ path: 'C:/tmp/pasted-7f3a-4c81', mime: 'image/png' }] },
      // 盘上是解码后的像素：读回来再编成 base64，正是线路上要交出去的那一串
      options({ statSize: () => 68, readFile: () => Buffer.from('AAAA', 'base64') }),
    )
    expect(prepared.images[0]).toMatchObject({ mediaType: 'image/png' })
    // 像素是裸 base64：data: 前缀会让供应商解不开，前缀由屏幕那一边拼
    expect(prepared.images[0]?.base64).toBe('AAAA')
    expect(prepared.images[0]?.base64.startsWith('data:')).toBe(false)
  })

  test('多张图按顺序都带上，各自带自己的路径与类型', () => {
    const prepared = preparePrompt(
      {
        ...INPUT,
        images: [
          { path: 'C:/tmp/a.png', mime: 'image/png' },
          { path: 'C:/tmp/b.jpg', mime: 'image/jpeg' },
        ],
      },
      options({ statSize: () => 4, readFile: () => Buffer.from('BBBB') }),
    )
    expect(prepared.images.map((image) => [image.mediaType, image.path])).toEqual([
      ['image/png', 'C:/tmp/a.png'],
      ['image/jpeg', 'C:/tmp/b.jpg'],
    ])
  })

  test('交出去的图片带着落盘路径标记（omp 靠它注入 image-attachment 伴生消息）', () => {
    const prepared = preparePrompt(
      { ...INPUT, images: [{ path: 'C:/tmp/tagged.png', mime: 'image/png' }] },
      options({ statSize: () => 4, readFile: () => Buffer.from('AAAA', 'base64') }),
    )
    const tagged = prepared.imageContents[0] as Record<string, unknown>
    expect(tagged).toMatchObject({ type: 'image', data: 'AAAA', mimeType: 'image/png' })
    // tagImageAttachmentSource 用符号挂来源；键集合里必须真的多出那一格
    expect(Object.getOwnPropertySymbols(tagged).length).toBe(1)
  })
})

describe('preparePrompt：普通文件与正文', () => {
  test('普通文件以 @绝对路径 逐行附在正文后面，由 agent 自己去读', () => {
    const prepared = preparePrompt(
      {
        ...INPUT,
        text: '看看这两个',
        files: [
          { path: 'C:/work/a.ts', name: 'a.ts' },
          { path: 'C:/work/notes.txt', name: 'notes.txt' },
        ],
      },
      options(),
    )
    expect(prepared.text).toBe('看看这两个\n@C:/work/a.ts\n@C:/work/notes.txt')
  })

  test('没有文件时正文原样，不加尾随空行', () => {
    expect(preparePrompt({ ...INPUT, text: '只有一句话' }, options()).text).toBe('只有一句话')
  })

  test('每一格都可以是空：空输入不炸，也不编空格子', () => {
    const prepared = preparePrompt({ ...INPUT, text: '' }, options())
    expect(prepared).toEqual({
      text: '',
      images: [],
      imageContents: [],
      skillNames: [],
    })
  })
})

describe('expandSkillMessage：技能', () => {
  test('技能不在会话里就报错，不静默丢掉', async () => {
    const error = await (async () => {
      try {
        await expandSkillMessage({ ...INPUT, skills: ['ponytail'] }, [], skillOptions({ availableSkills: ['review'] }))
        return undefined
      } catch (caught) {
        return caught
      }
    })()
    // 静默丢掉一个技能等于用户以为它生效了
    expect(codeOf(error)).toBe('kernel.not_found')
  })

  test('展开出来的技能块按顺序拼起来，块与块各自一个文本块', async () => {
    const message = await expandSkillMessage(
      { ...INPUT, text: '清理冗余代码', skills: ['review', 'ponytail'] },
      [],
      skillOptions({
        availableSkills: ['review', 'ponytail'],
        skillMessage: async (name) => ({ message: `[技能正文]${name}`, details: { name } }),
      }),
    )
    // 技能消息的内容块是各技能正文，块与块各自一个（与 legacy customSkillMessage 同形）
    expect(message?.content).toEqual([
      { type: 'text', text: '[技能正文]review' },
      { type: 'text', text: '[技能正文]ponytail' },
    ])
    expect(message?.customType).toBe('skill-prompt')
    expect(message?.attribution).toBe('user')
  })

  test('展开不出正文的技能不进技能块，但仍然算已挂上', async () => {
    const message = await expandSkillMessage(
      { ...INPUT, skills: ['a', 'b'] },
      [],
      skillOptions({
        availableSkills: ['a', 'b'],
        skillMessage: async (name) => (name === 'a' ? null : { message: '[b 的正文]', details: {} }),
      }),
    )
    expect(message?.content).toEqual([{ type: 'text', text: '[b 的正文]' }])
  })

  test('没挂技能时技能消息是 null，不编一个空串', async () => {
    expect(await expandSkillMessage({ ...INPUT, text: '直接问' }, [], skillOptions())).toBeNull()
  })

  test('展开技能时交上去的是用户的原话（官方模板的 {{userArgs}}）', async () => {
    const seen: string[] = []
    await expandSkillMessage(
      { ...INPUT, text: '清理冗余代码', skills: ['ponytail'] },
      [],
      skillOptions({
        availableSkills: ['ponytail'],
        skillMessage: async (_name, args) => {
          seen.push(args)
          return { message: '[技能正文]', details: {} }
        },
      }),
    )
    // 从前这里传的是 chip 上那格 args（调色板插的 chip 没有 args）：模型收到的只有技能正文
    expect(seen).toEqual(['清理冗余代码'])
  })
})
