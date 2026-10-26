import { loadMath } from '@poietica/design-system/prose'
import { completionBody, isTurnSettled } from '../session'
import type { ConversationActions } from './actions'
import type { ConversationSetup } from './context'
import { leaveMissingLanding } from './landing-guard'
import { followThreadWorkspace } from './workspace-follow'

/** 各条 `api.on…` 通知订阅，以及 onCoreLost / onCoreReady。 */
export function createConversationSubscriptions(setup: ConversationSetup, actions: ConversationActions): void {
  const { api, ctx, entryDefaults, layout, platform, sessions, side, stores, subagentTabs, transcripts } = setup
  const { drafts, notify, openThread } = actions

  ctx.lifecycle.onDispose(
    followThreadWorkspace({ navigation: setup.navigation, threads: stores.threads, workspaces: setup.workspaces }),
  )

  ctx.lifecycle.onDispose(
    api.onTimelineOps((p) => {
      /* 时间线的增量由端口层翻译成副本信号；这里只剩「真实那一轮到达 → 提交行销账」这一条与转录无关的副作用。 */
      const stamped = p.ops.flatMap((op) =>
        op.op === 'turn.upsert' && op.turn.clientTurnId !== undefined ? [op.turn.clientTurnId] : [],
      )
      if (stamped.length > 0) {
        /* 待发提交表在真实那一轮到达时销账。 */
        transcripts.settleSubmissions(p.threadId, stamped)
      }
    }).dispose,
  )
  /* 「Core 即时回显」的两条通知：提交行的存续与消失都由 Core 说了算。 */
  ctx.lifecycle.onDispose(
    api.onSubmissionChanged((p) => {
      transcripts.upsertSubmission(p.threadId, p.submission)
    }).dispose,
  )
  ctx.lifecycle.onDispose(
    api.onSubmissionRemoved((p) => {
      transcripts.removeSubmission(p.threadId, p.clientTurnId)
    }).dispose,
  )
  ctx.lifecycle.onDispose(api.onThreadUpdated((t) => stores.threads.upsert(t)).dispose)
  ctx.lifecycle.onDispose(
    api.onThreadRemoved((p) => {
      stores.threads.remove(p.threadId)
      stores.turnStates.clear(p.threadId)
      stores.completionUnread.clear(p.threadId)
      /* 两者各管一半（store 退订阅、注册表丢对象），必须从同一个入口发起 —— 少发一处就是「一边忘了一边还记得」的半状态。 */
      transcripts.forget(p.threadId)
      sessions.release(p.threadId)
      /* 右坞的子代理标签按对话号记账：对话没了，它们也没有可读的转录了。 */
      subagentTabs.forget(p.threadId)
      /* 右坞那一份（开合、格清单）同样按对话号记账；不清就只增不减，存盘里也可能留着一个已删对话的归属。 */
      layout.forgetOwner(p.threadId)
      /* 辅助对话的话题随对话一起删（存在会话的 artifacts 里，Core 那边已经没了） */
      side.forget(p.threadId)
    }).dispose,
  )
  /* 侧边提问（右坞辅助对话）的三条通知：快照整份替换，增量对不上 offset 由 store 自己重读 */
  ctx.lifecycle.onDispose(api.onSideTopic((p) => side.applyTopic(p.threadId, p.topic)).dispose)
  ctx.lifecycle.onDispose(api.onSideDelta((p) => side.applyDelta(p.threadId, p)).dispose)
  ctx.lifecycle.onDispose(api.onSideNotice((p) => side.applyNotice(p.threadId, p.message)).dispose)
  /*
   * 「结束」= turns.state 从 running / awaiting 回到 idle（CV-10）。判据用**前一份状态**：只看当前是 idle 会把 threads.list 的初始快照也当成一次「结束」，一打开软件就弹。
   * `document.hasFocus()` 与偏好由 notify() 统一判，测试只验这条规则。
   */
  ctx.lifecycle.onDispose(
    api.onTurnState((s) => {
      const previous = stores.turnStates.get(s.threadId)?.state
      stores.turnStates.set(s)
      /*
       * 「跑完但还没回来看」的绿点：只在 running / awaiting → idle 的边沿点亮，而且那条
       * 不能是当前正看着的这条（看着它跑完的人不需要被提醒）。判据与通知同一处取 previous。
       */
      stores.completionUnread.observe(s.threadId, previous, s.state, actions.activeThreadId())
      if (isTurnSettled(previous, s.state)) notify(s.threadId, completionBody(s.error), 'completion')
    }).dispose,
  )
  ctx.lifecycle.onDispose(api.onControlsChanged((p) => stores.controls.set(p.threadId, p.controls)).dispose)
  /* 上下文用量单独一条：它每轮都在变，而控件表只在模型 / 档位 / 模式变了才变。 */
  ctx.lifecycle.onDispose(api.onContextUsage((p) => stores.controls.setUsage(p.threadId, p.usage)).dispose)
  /* 需要确认的通知只发一次系统通知 —— 待答卡片本身来自时间线的 interactions 表，这里不再另存一份。 */
  ctx.lifecycle.onDispose(
    api.onInteractionRequested((p) => {
      notify(p.threadId, '需要你的确认', 'needs-confirm')
    }).dispose,
  )

  /* threadId 为 null 时什么都不做：没有目标就不跳，跳到「一个新对话」会是凭空多出来的行为。 */
  ctx.lifecycle.onDispose(
    platform.on('notify.clicked', ({ threadId }) => {
      if (threadId === null || threadId === '') return
      openThread(threadId)
    }).dispose,
  )

  ctx.lifecycle.onDispose(() => {
    transcripts.dispose()
  })

  /* Core 换代：运行态与已绑定对话全部不可信。这里只做同步的内存清理（onCoreLost 的硬要求：此刻 Core 不可用，RPC 会排队到超时），真正重读放在随后的 onCoreReady 里。 */
  ctx.lifecycle.onCoreLost(() => {
    stores.turnStates.resetAll()
    transcripts.markAllStale()
  })

  async function restoreReadySteps(
    steps: ReadonlyArray<readonly [string, () => unknown]>,
    signal: AbortSignal,
  ): Promise<void> {
    /* 每一步各自兜底：某一格抛错不该把后面的恢复步骤跳过 —— 原先整段共用一次 await，第一步失败就等于「重启之后什么都不再同步」。 */
    for (const [name, run] of steps) {
      if (signal.aborted) return
      try {
        await run()
      } catch (e) {
        if (signal.aborted) return
        ctx.logger.warn('core ready step failed', { step: name, error: String(e) })
      }
    }
  }

  let readyCount = 0
  ctx.lifecycle.onCoreReady(async ({ signal }) => {
    readyCount += 1
    const first = readyCount === 1
    if (first) {
      /* 首屏画完、开始拉历史时顺手预取公式模块（P-06），不阻塞这里的恢复步骤。 */
      void loadMath().catch((cause: unknown) => {
        ctx.logger.warn('公式渲染模块没能加载，公式将按源码显示', { error: String(cause) })
      })
    }
    const steps: Array<readonly [string, () => unknown]> = [
      ['threads', () => stores.threads.refresh()],
      /* 启动时恢复出来的那条对话已经删了 / 归档了：线程表一到就判，回入口页（landing-guard.ts）。只管启动落地，之后的删除 / 归档各有各的入口。 */
      ...(first
        ? ([
            ['landing', () => leaveMissingLanding({ api, navigation: setup.navigation, threads: stores.threads })],
          ] as const)
        : []),
      /*
       * 草稿与批准方式都在 setup 里由 uiState 槽恢复（契约 UI_STATE_RESTORE），这里不再读 —— 只有草稿读失败时（hold，保持「没恢复」）
       * 要再试：所以不是「只有第一次」，恢复到之前每次 ready 都试；已恢复时 retry 直接返回。
       */
      ['drafts', () => drafts.retry()],
      /*
       * 草稿里还没落账的模型 / 档位写成默认意图：上一次写失败（Core 正在换代）的在这里补。
       * 必须排在 drafts 之后 —— 草稿没读回来时这里读到的是空的。
       */
      ['entryDefaults', () => entryDefaults.flush()],
      [
        'transcripts',
        () => {
          for (const threadId of transcripts.resyncVisible()) {
            void stores.controls.refresh(threadId)
          }
        },
      ],
      /* Core 换代时正在答的那一问已经停了（落盘为 interrupted）：读过的对话重读一遍，屏幕上不留一个永远「正在答」 */
      ['side', () => side.reloadLoaded()],
    ]
    await restoreReadySteps(steps, signal)
  })
}
