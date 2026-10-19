import { describe, expect, test } from 'bun:test'
import type { RpcMessage, WindowBridge } from '@poietica/rpc'
import { createUiKernel, defineUiFeature } from '@poietica/ui-kernel'
import type { Attachment } from '../../contract'
import { type AttachmentsUi, AttachmentsUiToken, type DraftRefSource } from '../../ui-api'
import { DRAFTS_OWNER } from '../draft-refs'
import attachments from '../index'

/*
 * AttachmentsUiToken：attachments 只交自己的 Attachment，不认识输入框（功能分级：conversation → attachments）。
 * 用真内核 + 记账的假桥：钉住「归不归我」（null）、「归我但失败」（空数组）与草稿引用的 Core 就绪重发。
 */

const imported = (name: string): Attachment => ({
  id: `id-${name}`,
  sha256: 'a'.repeat(64),
  name,
  mime: 'text/markdown',
  size: 1,
  kind: 'file',
  createdAt: 0,
  previewUrl: null,
})

interface Call {
  readonly method: string
  readonly params: Record<string, unknown>
}

const RESULTS: Record<string, (params: Record<string, unknown>) => unknown> = {
  'core.getStatus': () => ({ state: 'ready', reason: null, attempt: 0 }),
  'attachments.importData': (p) => imported(String(p.name)),
  'attachments.importPaths': (p) => ({ attachments: (p.paths as string[]).map(imported) }),
  'attachments.setOwnerRefs': () => ({ missing: [] }),
  'dialog.pickFiles': () => ({ paths: ['C:/a.txt'] }),
}

function bridge(fail: ReadonlySet<string> = new Set()): { bridge: WindowBridge; calls: Call[] } {
  const calls: Call[] = []
  const listeners = new Set<(message: RpcMessage) => void>()
  const reply = (message: RpcMessage): void => {
    queueMicrotask(() => {
      for (const l of [...listeners]) l(message)
    })
  }
  return {
    calls,
    bridge: {
      send(message: RpcMessage) {
        if (!('id' in message) || typeof message.id !== 'number' || !('method' in message)) return
        const { id, method } = message
        const params = (message.params ?? {}) as Record<string, unknown>
        calls.push({ method, params })
        if (fail.has(method)) {
          const data = { code: 'kernel.internal', message: 'boom' }
          reply({ jsonrpc: '2.0', id, error: { code: -32000, message: 'boom', data } })
          return
        }
        reply({ jsonrpc: '2.0', id, result: RESULTS[method]?.(params) ?? {} })
      },
      onMessage(listener: (message: RpcMessage) => void) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      pathForFile: (file: File) => `C:/drop/${file.name}`,
    },
  }
}

async function boot(fail?: ReadonlySet<string>) {
  const b = bridge(fail)
  let service: AttachmentsUi | undefined
  const platform = defineUiFeature({ id: 'platform', setup: () => undefined })
  const consumer = defineUiFeature({
    id: 'consumer',
    dependsOn: ['attachments'],
    setup: (ctx) => {
      service = ctx.services.get(AttachmentsUiToken)
    },
  })
  const kernel = createUiKernel({
    features: [platform, attachments, consumer],
    errorMessages: {},
    validateResults: false,
    defaultRoute: { surface: 'conversation.home', params: {} },
    bridge: b.bridge,
  })
  await kernel.start()
  expect([...kernel.failures.keys()]).toEqual([])
  if (service === undefined) throw new Error('AttachmentsUiToken 没有提供')
  return { kernel, service, calls: b.calls }
}

const paste = (text: string): ClipboardEvent =>
  ({ clipboardData: { getData: () => text, items: [] } }) as unknown as ClipboardEvent
const lines = (n: number): string => Array.from({ length: n }, (_, i) => `第 ${String(i + 1)} 行`).join('\n')
const methods = (calls: readonly Call[], method: string) => calls.filter((c) => c.method === method)

describe('AttachmentsUiToken', () => {
  test('超长纯文字：同步认领，收成一份 .md 入库', async () => {
    const { kernel, service, calls } = await boot()
    try {
      expect(service.claimsPaste(paste(lines(60)))).toBe(true)
      const got = await service.fromPaste(paste(lines(60)))
      expect(got?.map((a) => a.name)).toEqual(['粘贴的文本.md'])
      expect(methods(calls, 'attachments.importData')[0]?.params).toMatchObject({ mime: 'text/markdown' })
    } finally {
      kernel.dispose()
    }
  })

  test('不归附件库的粘贴交回 null（短句、没有图）', async () => {
    const { kernel, service } = await boot()
    try {
      expect(service.claimsPaste(paste('一句话'))).toBe(false)
      expect(await service.fromPaste(paste('一句话'))).toBeNull()
    } finally {
      kernel.dispose()
    }
  })

  test('归附件库但入库失败：交回空数组（事件算被吃掉），不抛', async () => {
    const { kernel, service } = await boot(new Set(['attachments.importData']))
    try {
      expect(await service.fromPaste(paste(lines(60)))).toEqual([])
    } finally {
      kernel.dispose()
    }
  })

  test('拖放：本地路径入库；没有路径交回 null', async () => {
    const { kernel, service, calls } = await boot()
    try {
      const drop = (files: File[]): DragEvent => ({ dataTransfer: { files } }) as unknown as DragEvent
      expect(await service.fromDrop(drop([]))).toBeNull()
      const got = await service.fromDrop(drop([new File(['x'], 'a.txt')]))
      expect(got?.map((a) => a.name)).toEqual(['C:/drop/a.txt'])
      expect(methods(calls, 'attachments.importPaths')[0]?.params).toEqual({ paths: ['C:/drop/a.txt'] })
    } finally {
      kernel.dispose()
    }
  })

  test('选文件：先弹 platform 的对话框，再按选中的路径入库', async () => {
    const { kernel, service, calls } = await boot()
    try {
      const got = await service.pick(true)
      expect(got.map((a) => a.name)).toEqual(['C:/a.txt'])
      expect(methods(calls, 'dialog.pickFiles')[0]?.params).toEqual({ multiple: true })
    } finally {
      kernel.dispose()
    }
  })

  test('trackDraftRefs：集合变化后登记一次；撤销后不再登记', async () => {
    const { kernel, service, calls } = await boot()
    try {
      let ids: readonly string[] | null = null
      const listeners = new Set<() => void>()
      const source: DraftRefSource = {
        ids: () => ids,
        subscribe: (l) => {
          listeners.add(l)
          return () => listeners.delete(l)
        },
        drop: () => 0,
      }
      const untrack = service.trackDraftRefs(source)
      ids = ['b', 'a']
      for (const l of listeners) l()
      await Bun.sleep(700)
      expect(methods(calls, 'attachments.setOwnerRefs').map((c) => c.params)).toEqual([
        { ownerKey: DRAFTS_OWNER, attachmentIds: ['b', 'a'] },
      ])
      untrack()
      expect(listeners.size).toBe(0)
    } finally {
      kernel.dispose()
    }
  })
})
