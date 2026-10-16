import { loadMath } from '../components/timeline/prose/math-plugin'
import { completionBody, isTurnSettled } from '../session/notify'
import type { ConversationActions } from './actions'
import type { ConversationSetup } from './context'

/** 各条 `api.on…` 通知订阅，以及 onCoreLost / onCoreReady。 */
export function createConversationSubscriptions(setup: ConversationSetup, actions: ConversationActions): void {
  const { api, ctx, platform, preferences, posture, sessions, stores, transcripts } = setup
  const { draftPin, notify, openThread } = actions

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
      /* 两者各管一半（store 退订阅、注册表丢对象），必须从同一个入口发起 —— 少发一处就是「一边忘了一边还记得」的半状态。 */
      transcripts.forget(p.threadId)
      sessions.release(p.threadId)
    }).dispose,
  )
  /*
   * 「结束」= turns.state 从 running / awaiting 回到 idle（CV-10）。判据用**前一份状态**：只看当前是 idle 会把 threads.list 的初始快照也当成一次「结束」，一打开软件就弹。
   * `document.hasFocus()` 与偏好由 notify() 统一判，测试只验这条规则。
   */
  ctx.lifecycle.onDispose(
    api.onTurnState((s) => {
      const previous = stores.turnStates.get(s.threadId)?.state
      stores.turnStates.set(s)
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

  /*
   * `hydrate` 是 `{...当前, ...盘上}` 的合并：Core 每次重启都重读一遍，会把重启那一刻输入框里最近 300ms（UI 去抖）+ 500ms（Host 去抖）内敲的字用盘上的旧版本盖回去。
   * `posture.load()` 与它同一条理由。
   */
  /* 「读失败」与「盘上没有值」必须分开（R-07 §3.4）：混在一起会让 attachments 那一侧在一个空集合上做整体替换，把盘上草稿的引用全清掉。读成功（哪怕是 null）才算恢复完成。 */
  const loadDraftsOnce = async (): Promise<void> => {
    let storedDrafts: unknown
    try {
      storedDrafts = (await preferences.call('uiState.get', { key: 'conversation.drafts' })).value
    } catch (cause) {
      ctx.logger.warn('drafts load failed', { error: String(cause) })
      return
    }
    if (storedDrafts !== null && typeof storedDrafts === 'object') {
      stores.composer.hydrate(storedDrafts as Record<string, import('../composer/composer-store').Draft>)
    }
    draftPin.markRestored()
  }

  let readyCount = 0
  ctx.lifecycle.onCoreReady(async () => {
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
      ...(first ? ([['posture', () => posture.load()]] as const) : []),
      /* 读失败时保持「没恢复」，所以不是「只有第一次」—— 恢复到之前每次 ready 都试。 */
      ...(draftPin.restored() ? [] : ([['drafts', () => loadDraftsOnce()]] as const)),
      [
        'transcripts',
        () => {
          for (const threadId of transcripts.resyncVisible()) {
            void stores.controls.refresh(threadId)
          }
        },
      ],
    ]
    /* 每一步各自兜底：某一格抛错不该把后面的恢复步骤跳过 —— 原先整段共用一次 await，第一步失败就等于「重启之后什么都不再同步」。 */
    for (const [name, run] of steps) {
      try {
        await run()
      } catch (e) {
        ctx.logger.warn('core ready step failed', { step: name, error: String(e) })
      }
    }
  })
}
