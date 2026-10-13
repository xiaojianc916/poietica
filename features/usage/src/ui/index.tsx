/// <reference path="../../../../packages/design-system/src/css.d.ts" />

import type { Thread } from '@poietica/feature-conversation/contract'
import { conversationContract } from '@poietica/feature-conversation/contract'
import { modelsContract } from '@poietica/feature-models/contract'
import { builtinPoints, defineUiFeature, SETTINGS_GROUPS } from '@poietica/ui-kernel'
import { Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createUsageApi } from './api'
import type { ModelNames } from './model-labels'
import { UsageSettings } from './usage-settings'

/* 用量功能的 UI 装配。一个落点：settingsPages（agent, order 700）「用量」—— 概览 / 热力图 / 趋势图。
 * 线程标题栏那枚「累计 token 与费用」按钮（含悬停明细卡）已按产品决定删除，连同只为它存在的 usage.thread / usage.updated（refactor-log 偏差 #50）。
 * 数据来路：对话列表走 conversation 的 threads.list；三张图走 usage 契约的同名方法（窗口算式在 ui/api.ts）；模型名走 models 契约。
 * dependsOn 因此是 [conversation, models]，两条都是契约调用（守则 3）。 */
export default defineUiFeature({
  id: 'usage',
  dependsOn: ['conversation', 'models'],
  setup(ctx) {
    const api = createUsageApi(ctx)
    const conversations = ctx.rpc(conversationContract)
    const models = ctx.rpc(modelsContract)

    /* 账上记的是 provider/id，屏幕上要写名字（ADR 0017）。读一次 + 订阅 models.changed。读不到就交空表 —— labelModels 对空表的语义是
     * 「一个都不认识」，图例因此如实显示账上的别名，而不是显示一个我们编出来的名字。 */
    const readModelNames = (): Promise<ModelNames> =>
      models.call('models.catalog', {}).then(
        (r: { models: readonly { provider: string; id: string; name: string }[] }) =>
          new Map(r.models.map((m) => [`${m.provider}/${m.id}`, m.name])),
        () => new Map(),
      )

    /* 三项出自**对话列表本身**，与 token 无关：legacy 的 summarize 收的就是 thread.updatedAt 那一串，且把已归档的并起来一起喂。 */
    const readThreadTimes = (): Promise<readonly string[]> =>
      conversations.call('threads.list', { includeArchived: true }).then(
        (r: { threads: readonly Thread[] }) => r.threads.map((t) => new Date(t.updatedAt).toISOString()),
        () => [],
      )

    const watchThreads = (reload: () => void): { dispose(): void } => {
      const updated = conversations.on('threads.updated', reload)
      const removed = conversations.on('threads.removed', reload)

      return {
        dispose: () => {
          updated.dispose()
          removed.dispose()
        },
      }
    }

    const watchModels = (reload: () => void): { dispose(): void } => models.on('models.changed', reload)

    ctx.contribute(builtinPoints.settingsPages, {
      id: 'usage.overview',
      group: SETTINGS_GROUPS.agent,
      order: 700,
      title: '用量',
      icon: Zap,
      component: () => (
        <UsagePage
          readModelNames={readModelNames}
          readThreadTimes={readThreadTimes}
          usage={api}
          watchModels={watchModels}
          watchThreads={watchThreads}
        />
      ),
    })
  },
})

/* 把两份「读一次 + 订阅重读」的数据接上，再交给表面的组件。读写函数整份来自 setup（一次建好、引用终身不变）—— 表面的 useRead
 * 以读函数为 effect 依赖，换引用就是每次渲染都重读一次（见 ui/api.ts 那段头注）。 */
function UsagePage({
  readModelNames,
  readThreadTimes,
  usage,
  watchModels,
  watchThreads,
}: {
  readonly readModelNames: () => Promise<ModelNames>
  readonly readThreadTimes: () => Promise<readonly string[]>
  readonly usage: ReturnType<typeof createUsageApi>
  readonly watchModels: (reload: () => void) => { dispose(): void }
  readonly watchThreads: (reload: () => void) => { dispose(): void }
}) {
  const modelNames = useLive(readModelNames, watchModels)
  const threadTimes = useLive(readThreadTimes, watchThreads)

  return (
    <UsageSettings
      failure={null}
      modelNames={modelNames ?? EMPTY_NAMES}
      readMessageCount={usage.readMessageCount}
      readModelDays={usage.readModelDays}
      readTokenDays={usage.readTokenDays}
      threadTimes={threadTimes ?? EMPTY_TIMES}
    />
  )
}

const EMPTY_NAMES: ModelNames = new Map()
const EMPTY_TIMES: readonly string[] = []

/** 读失败与「还没读到」在这里是同一档（都交 undefined）：概览那几格因此显示占位符 —，而不是一个编出来的 0。 */
function useLive<T>(read: () => Promise<T>, watch: (reload: () => void) => { dispose(): void }): T | undefined {
  const [value, setValue] = useState<T>()

  useEffect(() => {
    let live = true

    const reload = (): void => {
      void read().then(
        (found) => {
          if (live) setValue(found)
        },
        () => undefined,
      )
    }

    reload()
    const off = watch(reload)

    return () => {
      live = false
      off.dispose()
    }
  }, [read, watch])

  return value
}
