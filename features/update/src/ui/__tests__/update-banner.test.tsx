import { describe, expect, test } from 'bun:test'
import type { ConversationUi } from '@poietica/feature-conversation/ui-api'
import { type Logger, noopLogger } from '@poietica/foundation'
import type { DialogService } from '@poietica/ui-kernel'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UpdateState as UpdateStateSchema } from '../../contract'
import type { UpdateApi } from '../api'
import { createUpdateStore } from '../store'
import { UpdateBanner } from '../update-banner'

/** 只收 warn 的假 logger：本包的 devDependencies 里没有 @poietica/test-kit */
function collectingLogger(): { logger: Logger; warns: string[] } {
  const warns: string[] = []
  const logger: Logger = {
    ...noopLogger,
    warn: (msg) => {
      warns.push(msg)
    },
    child: () => logger,
  }
  return { logger, warns }
}

/*
 * R-08-14：`update.download` 的传输层拒绝必须被收下。
 *
 * 契约把这一档的超时改成 0（结果由 update.stateChanged 说话），但连接换代、窗口关闭
 * 仍可能让请求以错误拒绝；从前是裸 `void api.download()`，那就是一条未处理的 rejection。
 */
describe('UpdateBanner 的下载动作（R-08-14）', () => {
  const state = UpdateStateSchema.parse({
    phase: 'available',
    currentVersion: '0.5.0',
    version: '1.2.3',
    notes: null,
    progress: null,
    error: null,
    lastCheckedAt: null,
  })

  function renderBanner(download: UpdateApi['download']) {
    const { logger, warns } = collectingLogger()
    const store = createUpdateStore()
    store.apply(state)
    const api = {
      download,
      /* 只有 download 会被这条用例碰到；其余给能自我说明的空实现 */
      state: async () => state,
      check: async () => state,
      install: async () => state,
      onStateChanged: () => ({ dispose: () => undefined }),
    } as unknown as UpdateApi
    render(
      <UpdateBanner
        api={api}
        conversation={{} as ConversationUi}
        dialogs={{} as DialogService}
        logger={logger}
        store={store}
      />,
    )
    return { logger, warns }
  }

  test('点「下载」发起请求', async () => {
    let calls = 0
    renderBanner(async () => {
      calls += 1
      return state
    })
    fireEvent.click(await screen.findByRole('button', { name: '下载' }))
    await waitFor(() => {
      expect(calls).toBe(1)
    })
  })

  test('请求拒绝只记 warn，不作为未处理异常冲出去', async () => {
    const { warns } = renderBanner(async () => {
      throw new Error('传输层断了')
    })
    fireEvent.click(await screen.findByRole('button', { name: '下载' }))
    /* 全仓测试并行跑时这一拍可能被别的文件拖长，waitFor 的默认 1 秒不够稳 */
    await waitFor(
      () => {
        expect(warns).toContain('update download failed')
      },
      { timeout: 5000 },
    )
  })
})
