import type { OpenSessionSpec } from '@poietica/engine'
import { noopLogger } from '@poietica/foundation'
import { InteractionBroker } from '../../interactions/broker'
import { LiveProjector } from '../../projector/live'
import { hashMediaRef } from '../../projector/media'
import type { OmpSessionHost } from '../session'

/*
 * 手工组装的 OmpSessionHost：直接驱动 OmpSession，不起进程、不碰磁盘。
 * 这是「被测对象自己的声明」——存根只在测试里，不进产品代码。各用例按需 over 掉要测的那几格。
 */
export const NOW = 1_700_000_000_000

export const SPEC: OpenSessionSpec = {
  key: 'controls',
  cwd: 'C:\\work',
  sessionFile: null,
  posture: 'ask',
  model: null,
  thinking: null,
}

export const EMPTY_PAGE: Awaited<ReturnType<OmpSessionHost['page']>> = {
  items: [],
  tasks: [],
  interactions: [],
  attachments: [],
  todos: [],
  prompts: [],
  meta: {},
  hasMoreOlder: false,
}

export function hostOf(over: Partial<OmpSessionHost> = {}): OmpSessionHost {
  /*
   * 计划与目标的状态住在**会话**那一侧（真实适配器里由 setPlanModeState / goalRuntime 持），
   * 控件表每次现读它（livePlanMode / liveGoal）。夹具因此也得是有状态的：恒返回 false / null
   * 会让「切了模式但控件表没跟着变」这类缺陷在这里看起来是通过的。
   */
  let planMode = false
  let goal: string | null = null
  return {
    spec: SPEC,
    logger: noopLogger,
    broker: new InteractionBroker(() => NOW),
    projector: new LiveProjector({ now: () => NOW }),
    loadImages: async () => [],
    mediaRef: hashMediaRef,
    /* 定名：这一档用例不测它，给一个什么都不做的实现 */
    setSessionName: async () => true,
    /* 斜杠命令：这一档用例不测它 */
    commands: async () => [],
    resolveCommand: async () => null,
    runBuiltinCommand: async () => ({ kind: 'local' }),
    reseat: () => undefined,
    promptWithImages: async () => true,
    /* 子代理 / 后台作业的控制：这一档用例不测它 */
    cancelSubagent: async () => false,
    steerSubagent: async () => undefined,
    cancelBackgroundTask: async () => false,
    /* 侧边提问：这一档用例不测它（side-questions.test.ts 单测） */
    side: {
      busy: false,
      ask: async () => Promise.reject(new Error('side questions are not wired')),
      cancel: () => false,
      topics: async () => [],
      close: async () => undefined,
    },
    steer: async () => ({ wireText: '' }),
    abort: async () => undefined,
    disposeSession: async () => undefined,
    queueOf: () => ({ steering: [], followUp: [] }),
    removeQueued: () => true,
    setQueueMode: () => undefined,
    setApprovalMode: () => undefined,
    grantTool: () => undefined,
    liveModel: () => null,
    liveThinking: () => null,
    lastAssistant: () => undefined,
    contextUsage: () => null,
    thinkingChoices: () => [],
    modelChoices: () => [],
    modelLabel: (model) => `${model.provider}/${model.id}`,
    thinkingFallback: () => [],
    defaultThinking: () => null,
    setModelOnSession: async () => undefined,
    setThinkingOnSession: () => undefined,
    skillMessage: async () => null,
    /* 计划 / 目标：默认「可用 + 没开」，需要哪一档的用例自己 over 掉 */
    applyPlanMode: async (enabled) => {
      planMode = enabled
    },
    applyGoal: async (next) => {
      goal = next
    },
    pauseGoal: async () => undefined,
    resumeGoal: async () => undefined,
    goalContinuationPending: () => false,
    stopGoalContinuation: () => undefined,
    planAvailable: () => true,
    goalAvailable: () => true,
    livePlanMode: () => planMode,
    liveGoal: () => goal,
    liveGoalSnapshot: () =>
      goal === null
        ? null
        : {
            objective: goal,
            completionCriterion: null,
            status: 'active' as const,
            turnsUsed: 0,
            tokensUsed: 0,
            wallClockMs: 0,
          },
    page: async () => EMPTY_PAGE,
    now: () => NOW,
    ...over,
  }
}
