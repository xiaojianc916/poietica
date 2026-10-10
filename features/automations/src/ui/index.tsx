/// <reference path="../../../../packages/design-system/src/css.d.ts" />

import { conversationContract, MAIN_AGENT_ID, type Thread } from '@poietica/feature-conversation/contract'
import {
  type ConversationUi,
  ConversationUiToken,
  threadActions,
  toolCallRenderers,
} from '@poietica/feature-conversation/ui-api'
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

/*
 * automations 的 UI 装配（07 页 §9E）。
 *
 * 落点与读法：
 *   surfaces —— automations.list（任务列表 + 模板画廊）、automations.edit（参数
 *               automationId，新建为 'new'）
 *   sidebarSections（order 30）——“定时任务”，右侧显示启用数
 *   conversation 的 threadActions —— “以此对话创建定时任务”
 *   conversation 的 toolCallRenderers —— /^automation_/ → 任务卡片
 *
 * 与 legacy 的差别只在数据来源：legacy 的 AutomationGateway / createAutomationStore
 * 在这里换成 automations 契约的 RPC 与 createAutomationsStore。界面文案、几何与动效
 * 一字未改（列表页、编辑页、模板画廊、运行历史都是 legacy 的逐字迁移）。
 */

function defaultTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/* ── threadActions：线程 → 预填一条草稿 ──────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 时间线里第一条用户消息的正文：legacy 的预填读的就是它。 */
function firstUserPrompt(items: readonly unknown[]): string | null {
  for (const item of items) {
    if (!isRecord(item) || item.kind !== 'turn') {
      continue
    }
    const origin = item.origin
    const kind = isRecord(origin) ? origin.kind : undefined
    /* conversation 契约的 origin 只有 user / automation 两档；automation 那条不预填。 */
    if (kind === undefined || kind === 'user') {
      const prompt = item.prompt
      if (typeof prompt === 'string' && prompt.trim() !== '') {
        return prompt
      }
    }
  }
  return null
}

/** 当前页最早一轮的 id；没有轮次就返回 null。 */
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
    const navigation = ctx.services.get(NavigationToken) as NavigationService
    const conversation = ctx.services.get(ConversationUiToken) as ConversationUi
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

    /*
     * ── 系统通知（审查 R-16）────────────────────────────────────────────────
     *
     * 该不该通知只在 Core 的 notice.ts 判（任务的通知策略 × 这次运行的结局）；这里原样
     * 转给 platform 的 notify.show。带 threadId：点通知由 conversation 的 notify.clicked
     * 那一条打开对话（conversation/ui/index.tsx），这里不再接点击。主窗口聚焦时 platform
     * 本来就不弹。conversation 自己那两条（一轮结束 / 需要确认）对定时任务的对话不再发
     * （见 conversation/ui/index.tsx 的 notify 头注），所以同一件事只响一次。
     */
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

    /* ── 表面：列表与编辑（legacy 的单页在路由上拆成两格）──────────────────── */
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

    /*
     * ── 侧栏导航：自动化（order 30）──────────────────────────────────────────
     *
     * 行的文案与图标取 legacy 的 SURFACE_REGISTRY（tab-id `automations`，title
     * 「自动化」、图标 clock）—— 用户给定的基准截图（#02）里这一行写的就是「自动化」。
     * 右侧的启用数只在大于 0 时画：0 是一个没有信息量的数字，而 legacy 的导航行
     * 本来就不带计数（07 页 §9E 要求「显示启用数」，这一条在零个任务时的外观与
     * 基准截图冲突，取截图，记入 docs/refactor-log.md）。
     */
    ctx.contribute(builtinPoints.sidebarSections, {
      id: 'automations.nav',
      order: 30,
      title: '自动化',
      icon: AlarmClock,
      placement: 'nav',
      component: () => <AutomationsNavRow navigation={navigation} store={store} />,
    })

    /* ── conversation：线程动作与工具卡片 ─────────────────────────────────── */
    ctx.contribute(threadActions, {
      id: 'automations.createFromThread',
      order: 30,
      title: '以此对话创建定时任务',
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

    /** 线程没有可读消息时只预填工作区；标题沿用线程标题。 */
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

/*
 * 侧栏「定时任务」一行。
 *
 * 行的几何由 workbench 的全局样式持有（.sidebar-nav-row / __icon / __label，逐字迁移自
 * legacy 的 sidebar-rows.css），这里只贡献文字、图标与右侧的启用数；高亮跟着路由。
 */
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
