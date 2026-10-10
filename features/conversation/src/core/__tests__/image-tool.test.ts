import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { EngineToolContext, EngineToolSpec } from '@poietica/engine'
import type { AttachmentsService, DescribedAttachment } from '@poietica/feature-attachments/core-api'
import { workspacesContract } from '@poietica/feature-workspaces/contract'
import { AppError } from '@poietica/foundation'
import { dataLayout } from '@poietica/runtime-layout'
import { tempDir } from '@poietica/test-kit'
import { conversationContract } from '../../contract'
import { registerImageTool } from '../image-tool'
import { harness } from './helpers'

/*
 * agent 往对话里展示图片（审查 R-13）。导入管线本身（去重、50 MB、扩展名定 mime）由
 * attachments 的 service.test.ts 覆盖；这里只钉工具自己的判断：路径怎么解析、哪些类型收、
 * 挂到哪把 ownerKey、交回什么样的一行。
 */

const SHA = 'a'.repeat(64)
const URL_OF = (mime: string) => `poietica-asset://attachment/${SHA}?mime=${encodeURIComponent(mime)}`

interface Rig {
  readonly tool: EngineToolSpec
  readonly imported: string[][]
  readonly retained: { ids: readonly string[]; owner: string }[]
}

function rig(importPaths?: AttachmentsService['importPaths']): Rig {
  const specs: EngineToolSpec[] = []
  const imported: string[][] = []
  const retained: { ids: readonly string[]; owner: string }[] = []
  const attachments: AttachmentsService = {
    importPaths:
      importPaths ??
      (async (paths) => {
        imported.push([...paths])
        return paths.map(
          (p): DescribedAttachment => ({
            id: 'att-1',
            name: p.split(/[\\/]/).at(-1) ?? p,
            mime: 'image/png',
            kind: 'image',
            size: 3,
            previewUrl: URL_OF('image/png'),
          }),
        )
      }),
    resolve: () => [],
    describe: () => [],
    retain: (ids, owner) => {
      retained.push({ ids, owner })
    },
    releaseOwner: () => undefined,
    copyOwner: () => undefined,
  }
  registerImageTool({ tools: { register: (spec) => specs.push(spec) }, attachments })
  const tool = specs[0]
  if (tool === undefined) throw new Error('show_image 没有注册')
  return { tool, imported, retained }
}

const CWD = process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo'
const ctx: EngineToolContext = { cwd: CWD, signal: new AbortController().signal, sessionKey: 'thread-1' }

async function errorOf(promise: Promise<unknown>): Promise<AppError | null> {
  return await promise.then(
    () => null,
    (error: unknown) => error as AppError,
  )
}

describe('show_image（审查 R-13）', () => {
  test('I1 注册：名字 show_image、只读审批、中文标签', () => {
    const { tool } = rig()
    expect(tool.name).toBe('show_image')
    expect(tool.approval).toBe('read')
    expect(tool.label).toBe('展示图片')
  })

  test('I2 相对路径按工作目录解析；导入后挂到这条对话名下；交回一行附件协议的 markdown', async () => {
    const { tool, imported, retained } = rig()
    const result = await tool.execute({ path: 'out/chart.png' }, ctx)
    expect(imported).toEqual([[path.resolve(CWD, 'out/chart.png')]])
    expect(retained).toEqual([{ ids: ['att-1'], owner: 'conversation:thread:thread-1' }])
    expect(result.text).toBe(`![chart.png](${URL_OF('image/png')})`)
    expect(result.isError).toBeUndefined()
  })

  test('I3 caption 作替代文字：方括号与换行清掉，不会把这一行拆坏', async () => {
    const { tool } = rig()
    const result = await tool.execute({ path: '/tmp/a.png', caption: ' 正弦[曲线]\n第二行 ' }, ctx)
    expect(result.text).toBe(`![正弦 曲线 第二行](${URL_OF('image/png')})`)
  })

  test('I4 显示不了的类型（.tiff、无扩展名）：抛 invalid_params，既不导入也不挂引用', async () => {
    const { tool, imported, retained } = rig()
    const tiff = await errorOf(tool.execute({ path: 'scan.TIFF' }, ctx))
    expect(tiff?.code).toBe('kernel.invalid_params')
    expect(tiff?.message).toContain('.tiff')
    const bare = await errorOf(tool.execute({ path: 'README' }, ctx))
    expect(bare?.message).toContain('无扩展名')
    expect(imported).toEqual([])
    expect(retained).toEqual([])
  })

  test('I5 扩展名大小写不敏感：.PNG / .JpEg 照收', async () => {
    const { tool, imported } = rig()
    await tool.execute({ path: 'A.PNG' }, ctx)
    await tool.execute({ path: 'b.JpEg' }, ctx)
    expect(imported).toHaveLength(2)
  })

  test('I6 导入失败（文件不存在、超过 50 MB）：错误原样抛给模型，不挂引用', async () => {
    const missing = new AppError('attachments.unreadable', '无法读取文件：/tmp/none.png')
    const { tool, retained } = rig(async () => {
      throw missing
    })
    expect(await errorOf(tool.execute({ path: '/tmp/none.png' }, ctx))).toBe(missing)
    expect(retained).toEqual([])
  })
})

describe('show_image 经真内核（审查 R-13）', () => {
  test('M1 agent 调 show_image：文件进附件库、挂到这条对话名下，交回的地址就是附件协议的那一行', async () => {
    const dir = await tempDir('show-image-')
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    writeFileSync(path.join(dir.path, 'shot.png'), png)
    const { h, engine } = await harness({
      script: () => [{ kind: 'tool', name: 'show_image', args: { path: 'shot.png' }, result: '' }],
    })
    const ws = await h.client(workspacesContract).call('workspaces.add', { path: dir.path })
    const api = h.client(conversationContract)
    const thread = await api.call('threads.create', { workspaceId: ws.id })
    await api.call('turns.submit', {
      threadId: thread.id,
      clientTurnId: 'T1',
      text: '发一张图给我',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
    // 导入是真的磁盘 I/O（复制、算 sha），假时钟推不动它：边推时钟边让出真实时间，等到这一次调用记下来
    for (let i = 0; i < 200 && !engine.toolCalls.some((c) => c.name === 'show_image'); i++) {
      await h.clock.advanceAsync(20)
      await Bun.sleep(5)
    }
    const call = engine.toolCalls.find((c) => c.name === 'show_image')
    const sha = createHash('sha256').update(png).digest('hex')
    expect(call?.sessionKey).toBe(thread.id)
    expect(call?.result).toBe(`![shot.png](poietica-asset://attachment/${sha}?mime=image%2Fpng)`)
    expect(existsSync(path.join(dataLayout(h.dataRoot).attachmentsDir, sha.slice(0, 2), sha))).toBe(true)
    await h.dispose()
    await dir.dispose()
  })
})
