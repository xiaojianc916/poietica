import { describe, expect, test } from 'bun:test'
import { createCoreHarness } from '@poietica/core-kernel/testing'
import { createFakeEngine } from '@poietica/engine-testkit'
import { AppError } from '@poietica/foundation'
import { fakeClock } from '@poietica/test-kit'
import { attachmentsContract } from '../../contract'
import attachments from '../index'

/**
 * attachments 模块级测试：契约方法经真实内核走一遍。
 *
 * R-07 T5：`ownerKey` 只放行 `ui:` 前缀 —— UI 只能整体替换自己那一份引用，
 * 放开成任意 ownerKey 就等于让 UI 能误删 Core 的引用。
 */
async function harness() {
  const clock = fakeClock()
  const h = await createCoreHarness({
    modules: [attachments],
    engine: createFakeEngine({ clock }),
    clock,
  })
  return { h, api: h.client(attachmentsContract) }
}

describe('attachments 模块（R-07 §3.2）', () => {
  test('R-07 T5 setOwnerRefs 只接受 ui: 前缀的 ownerKey，Core 的 ownerKey 被判参数无效', async () => {
    const { h, api } = await harness()
    const err = await api
      .call('attachments.setOwnerRefs', { ownerKey: 'conversation:thread:x', attachmentIds: [] })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).code).toBe('kernel.invalid_params')
    await h.dispose()
  })

  test('R-07 setOwnerRefs 的正常往返：不存在的 id 交回 missing，存在的被登记（幂等）', async () => {
    const { h, api } = await harness()
    expect(
      await api.call('attachments.setOwnerRefs', { ownerKey: 'ui:conversation.drafts', attachmentIds: [] }),
    ).toEqual({ missing: [] })
    /* 同一个 owner 连续两次替换：第二次的 missing 就是「这条 id 已经不在库里」 */
    const again = await api.call('attachments.setOwnerRefs', {
      ownerKey: 'ui:conversation.drafts',
      attachmentIds: ['ghost'],
    })
    expect(again).toEqual({ missing: ['ghost'] })
    await h.dispose()
  })
})
