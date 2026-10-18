/// <reference path="../../../../packages/design-system/src/css.d.ts" />

import { conversationContract, MAIN_AGENT_ID, type Thread } from '@poietica/feature-conversation/contract'
import { ConversationUiToken, threadActions, toolCallRenderers } from '@poietica/feature-conversation/ui-api'
import { platformContract } from '@poietica/feature-platform/contract'
import {
  builtinPoints,
  defineUiFeature,
  type NavigationService,
  NavigationToken,
  useFeatureStore,
  useNavigation,
} from '@poietica/ui-kernel'
import { AlarmClock } from 'lucide-react'
import type { ReactNode } from 'react'
import type { AutomationDraft } from '../contract'
import { createAutomationsApi } from './api'
import { DEFAULT_SCHEDULE } from './automation'
import { createAutomationToolCard } from './automation-tool-card'
import { type AutomationsStore, createAutomationsStore } from './automations-store'
import { AutomationsEditSurface, AutomationsListSurface } from './automations-surface'

/* automations 的 UI 装配。落点：surfaces —— automations.list 与 automations.edit；sidebarSections(order 30)「定时任务」，
 * 右侧显示启用数；conversation 的 threadActions「以此对话创建定时任务」；conversation 的 toolCallRenderers（/^automation_/）。 */

function defaultTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function firstUserPrompt(items: readonly unknown[]): string | null {
  for (const item of items) {
    if (!isRecord(item) || item.kind !== 'turn') {
      continue
    }
    const origin = item.origin
    const kind = isRecord(origin) ? origin.kind : undefined
    if (kind === undefined || kind === 'user') {
      const prompt = item.prompt
      if (typeof prompt === 'string' && prompt.trim() !== '') {
        return prompt
      }
    }
  }
  return null
}

function oldestTurnId(items: readonly unknown[]): string | null {
  for (const item of items) {
    if (isRecord(item) && item.kind === 'turn' && typeof item.turnId === 'string') {
      return item.turnId
    }
  }
  return null
}

export default defineUiFeature({
  id: 'automations',
  dependsOn: ['conversation', 'workspaces', 'platform'],
  setup(ctx) {
    const navigation = ctx.services.get(NavigationToken)
    const conversation = ctx.services.get(ConversationUiToken)
    const api = createAutomationsApi(ctx)
    const store = createAutomationsStore({ api, logger: ctx.logger })

    let stopStore: (() => void) | null = null
    ctx.lifecycle.onCoreReady(() => {
      if (stopStore === null) {
        stopStore = store.start()
      } else {
        void store.refresh()
      }
    })
    ctx.lifecycle.onDispose(() => {
      stopStore?.()
      stopStore = null
    })

    /* 系统通知：该不该通知只在 Core 的 notice.ts 判，这里原样转给 platform 的 notify.show。点通知由 conversation 的 notify.clicked
     * 打开对话；主窗口聚焦时 platform 本来就不弹。 */
    const platform = ctx.rpc(platformContract)
    ctx.lifecycle.onDispose(
      api.onAttention((attention) => {
        const target = attention.threadId === null ? {} : { threadId: attention.threadId }
        void platform
          .call('notify.show', { title: attention.title, body: attention.body, ...target })
          .catch((cause: unknown) => {
            ctx.logger.warn('定时任务通知发送失败', { error: String(cause) })
          })
      }).dispose,
    )

    ctx.contribute(builtinPoints.surfaces, {
      id: 'automations.list',
      title: '自动化',
      component: () => (
        <AutomationsListSurface
          defaultTimeZone={defaultTimeZone()}
          onOpenThread={conversation.openThread}
          store={store}
        />
      ),
    })
    ctx.contribute(builtinPoints.surfaces, {
      id: 'automations.edit',
      title: '定时任务',
      component: ({ params }: { readonly params: Readonly<Record<string, string>> }) => (
        <AutomationsEditSurface
          automationId={String(params.automationId ?? 'new')}
          defaultTimeZone={defaultTimeZone()}
          onOpenThread={conversation.openThread}
          store={store}
        />
      ),
    })

    /* 侧栏导航：自动化（order 30）。文案与图标取 legacy 的 SURFACE_REGISTRY；右侧启用数只在大于 0 时画：0 没有信息量，
     * 与基准截图一致（记入 docs/refactor-log.md）。 */
    ctx.contribute(builtinPoints.sidebarSections, {
      id: 'automations.nav',
      order: 30,
      title: '自动化',
      icon: AlarmClock,
      placement: 'nav',
      component: () => <AutomationsNavRow navigation={navigation} store={store} />,
    })

    ctx.contribute(threadActions, {
      id: 'automations.createFromThread',
      order: 30,
      title: '创建定时任务',
      icon: AlarmClock,
      run: async (thread: Thread) => {
        store.pendingDraft = await prefillFromThread(thread)
        navigation.navigate({ surface: 'automations.edit', params: { automationId: 'new' } })
      },
    })
    ctx.contribute(toolCallRenderers, {
      toolName: /^automation_/,
      component: createAutomationToolCard({
        useExists: (automationId) =>
          useFeatureStore(store.store, (held) => held.automations.some((row) => row.id === automationId)),
        openAutomation: (automationId) => {
          navigation.navigate({ surface: 'automations.edit', params: { automationId } })
        },
        runNow: (automationId) => {
          void store.runNow(automationId)
        },
        openThread: conversation.openThread,
      }),
    })

    async function prefillFromThread(thread: Thread): Promise<AutomationDraft> {
      const rpc = ctx.rpc(conversationContract)
      const agentId = MAIN_AGENT_ID
      let prompt: string | null = null
      let subscribed = false
      try {
        let page = (await rpc.call('timeline.subscribe', { threadId: thread.id, agentId })).page
        subscribed = true
        for (let turn = 0; turn < 10; turn += 1) {
          prompt = firstUserPrompt(page.items)
          if (prompt !== null || page.hasMoreOlder !== true) {
            break
          }
          const beforeTurnId = oldestTurnId(page.items)
          if (beforeTurnId === null) {
            break
          }
          page = await rpc.call('timeline.page', { threadId: thread.id, agentId, beforeTurnId })
        }
      } catch (cause: unknown) {
        ctx.logger.warn('定时任务预填：线程首条用户消息读取失败', { error: String(cause) })
      } finally {
        if (subscribed) {
          try {
            await rpc.call('timeline.unsubscribe', { threadId: thread.id, agentId })
          } catch (cause: unknown) {
            ctx.logger.warn('定时任务预填：时间线退订失败', { error: String(cause) })
          }
        }
      }
      const title = thread.title === '' ? '未命名定时任务' : thread.title.slice(0, 80)
      return {
        title,
        prompt: prompt ?? '',
        schedule: { cron: DEFAULT_SCHEDULE, at: null, timeZone: defaultTimeZone() },
        workspaceId: thread.workspaceId,
        posture: thread.posture,
        model: null,
        thinking: null,
        threadMode: 'new',
        threadId: null,
        notify: 'attention',
        catchUp: true,
      }
    }
  },
})

function AutomationsNavRow({
  navigation,
  store,
}: {
  readonly navigation: NavigationService
  readonly store: AutomationsStore
}): ReactNode {
  const enabled = useFeatureStore(
    store.store,
    (held) => held.automations.filter((automation) => automation.enabled).length,
  )
  const { route } = useNavigation()
  const active = route.surface === 'automations.list' || route.surface === 'automations.edit'
  const className = [
    'sidebar-nav-row text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent',
    active ? 'bg-sidebar-accent text-foreground' : '',
  ]
    .filter((part) => part !== '')
    .join(' ')

  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={className}
      onClick={() => {
        navigation.navigate({ surface: 'automations.list', params: {} })
      }}
      type="button"
    >
      <AlarmClock aria-hidden="true" className="sidebar-nav-row__icon" />
      <span className="sidebar-nav-row__label">自动化</span>
      {enabled === 0 ? null : (
        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{enabled}</span>
      )}
    </button>
  )
}
