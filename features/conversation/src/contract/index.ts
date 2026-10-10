import { defineContract, defineMethod, defineNotification } from '@poietica/contract-kit'
import {
  ContextUsage,
  Controls,
  DeliverAs,
  Interaction,
  InteractionAnswer,
  ModelRef,
  Posture,
  QueueSnapshot,
} from '@poietica/engine'
import { z } from 'zod'
import { SubmissionView, Thread, ThreadInit, TimelineSnapshot, TurnState } from './entities'
import { conversationErrors } from './errors'
import { pageSchema, timelineOperationSchema } from './wire'

export * from './entities'
export { conversationErrors } from './errors'
export type { WireTranscriptOperation } from './wire'

const empty = z.object({})

/** 时间线增量批次：epoch 与 seq 的规则见 05 页 §12.2 */
const TimelineBatch = z.object({
  seq: z.number().int().positive(),
  ops: z.array(timelineOperationSchema),
})

export const conversationContract = defineContract({
  id: 'conversation',
  namespaces: ['threads', 'turns', 'timeline', 'queue', 'controls', 'interactions', 'submissions'],
  methods: [
    defineMethod({
      name: 'threads.list',
      owner: 'core',
      params: z.object({ workspaceId: z.string().optional(), includeArchived: z.boolean() }),
      result: z.object({ threads: z.array(Thread) }),
      description: '列出线程（pinned DESC, updated_at DESC）',
    }),
    defineMethod({
      name: 'threads.get',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1) }),
      result: Thread,
      description: '读一个线程',
    }),
    defineMethod({
      name: 'threads.create',
      owner: 'core',
      params: ThreadInit,
      result: Thread,
      description: '新建线程（不创建 omp 会话）',
    }),
    defineMethod({
      name: 'threads.open',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1) }),
      result: Thread,
      description: '打开线程（后台预热会话，预热失败不报错）',
    }),
    defineMethod({
      name: 'threads.close',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1) }),
      result: empty,
      description: '提示会话池可以驱逐这个线程的会话',
    }),
    defineMethod({
      name: 'threads.rename',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1), title: z.string() }),
      result: Thread,
      description: '重命名线程（titleSource 变为 user）',
    }),
    defineMethod({
      name: 'threads.setPinned',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1), pinned: z.boolean() }),
      result: Thread,
      description: '置顶或取消置顶',
    }),
    defineMethod({
      name: 'threads.setArchived',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1), archived: z.boolean() }),
      result: Thread,
      description: '归档或取消归档',
    }),
    defineMethod({
      name: 'threads.delete',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1) }),
      result: empty,
      description: '删除线程（运行中：conversation.thread_busy）',
    }),
    defineMethod({
      name: 'threads.fork',
      owner: 'core',
      params: z.object({
        threadId: z.string().min(1),
        undoTurns: z.number().int().nonnegative(),
        title: z.string().optional(),
      }),
      result: Thread,
      description: '从某个线程分支出一个新线程',
    }),
    defineMethod({
      name: 'threads.export',
      owner: 'core',
      params: z.object({
        threadId: z.string().min(1),
        format: z.enum(['html', 'markdown']),
        targetPath: z.string().min(1),
      }),
      result: z.object({ path: z.string() }),
      timeoutMs: 120_000,
      description: '导出线程为 HTML 或 Markdown',
    }),

    defineMethod({
      name: 'turns.submit',
      owner: 'core',
      params: z.object({
        threadId: z.string().min(1),
        clientTurnId: z.string().min(1),
        text: z.string(),
        attachmentIds: z.array(z.string()),
        skills: z.array(z.string()),
        deliverAs: DeliverAs,
      }),
      /*
       * 「Core 即时回显」：这里只做查表级检查就返回（**不打开会话、不读附件文件**），
       * 交回 Core 已经存下的那条记录。界面拿到它就能立刻画出用户气泡 —— 气泡是 Core 的
       * 事实，不是界面自己造的。
       */
      result: z.object({ submission: SubmissionView }),
      timeoutMs: 60_000,
      description: '提交一条用户输入；只存库与推送，慢事在后台交接',
    }),
    defineMethod({
      name: 'submissions.retry',
      owner: 'core',
      params: z.object({ clientTurnId: z.string().min(1) }),
      result: z.object({ submission: SubmissionView }),
      description: '重试一条失败的提交（号不变）',
    }),
    defineMethod({
      name: 'submissions.discard',
      owner: 'core',
      params: z.object({ clientTurnId: z.string().min(1) }),
      result: empty,
      description: '丢弃一条失败的提交',
    }),
    defineMethod({
      name: 'turns.cancel',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1) }),
      result: empty,
      description: '取消当前运行',
    }),

    defineMethod({
      name: 'timeline.subscribe',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1), agentId: z.string().min(1) }),
      /*
       * 除快照外还交回这个线程的**待显示提交**（`pending` / `failed`，加上 `turnId` 不在
       * 本页里的 `started`）。线程还没有会话时也要返回 —— 新对话的气泡就靠它。
       */
      result: TimelineSnapshot,
      description: '取时间线快照（含 epoch、seq 与待显示提交）并开始推送增量',
    }),
    defineMethod({
      name: 'timeline.unsubscribe',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1), agentId: z.string().min(1) }),
      result: empty,
      description: '停止推送这个通道的增量',
    }),
    defineMethod({
      name: 'timeline.page',
      owner: 'core',
      params: z.object({
        threadId: z.string().min(1),
        agentId: z.string().min(1),
        beforeTurnId: z.string().nullable(),
      }),
      result: pageSchema,
      description: '加载更早的一页',
    }),
    defineMethod({
      name: 'timeline.catchUp',
      owner: 'core',
      params: z.object({
        threadId: z.string().min(1),
        agentId: z.string().min(1),
        epoch: z.number().int(),
        sinceSeq: z.number().int().nonnegative(),
      }),
      result: z.object({
        batches: z.array(TimelineBatch),
        latestSeq: z.number().int().nonnegative(),
        complete: z.boolean(),
      }),
      description: '补发错过的批次',
    }),
    defineMethod({
      name: 'queue.get',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1) }),
      result: QueueSnapshot,
      description: '读队列快照',
    }),
    defineMethod({
      name: 'queue.withdraw',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1), itemId: z.string().min(1) }),
      result: QueueSnapshot,
      description: '撤回一条排队中的输入；已被 agent 消费时抛 engine.queue_item_consumed',
    }),
    defineMethod({
      name: 'queue.move',
      owner: 'core',
      params: z.object({
        threadId: z.string().min(1),
        itemId: z.string().min(1),
        deliverAs: z.enum(['steer', 'followUp']),
      }),
      result: QueueSnapshot,
      description: '把一条排队中的输入换到另一层（保留附件与技能）',
    }),
    defineMethod({
      name: 'queue.setModes',
      owner: 'core',
      params: z.object({
        threadId: z.string().min(1),
        steer: z.enum(['all', 'one-at-a-time']).optional(),
        followUp: z.enum(['all', 'one-at-a-time']).optional(),
      }),
      result: QueueSnapshot,
      description: '设置插话与排队的投递模式',
    }),

    /*
     * 入口那一格（还没有对话）的选择器：**草稿**控件表。
     *
     * 它只读，不开会话、不写设置、不碰文件（方案 §04）。草案与会话页共用同一个
     * 选择器组件，只是入口页改选择只改本地草稿、不改全局默认；发送时把选中的值
     * 带进 `threads.create` 的 `ThreadInit`（方案 §07「入口页改选择只改本地草稿」）。
     */
    defineMethod({
      name: 'controls.draft',
      owner: 'core',
      params: z.object({
        model: ModelRef.nullable(),
        thinking: z.string().nullable(),
        posture: Posture.nullable(),
      }),
      result: Controls,
      description: '读入口那一格（草稿）的控件表：只读，不开会话',
    }),
    defineMethod({
      name: 'controls.get',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1) }),
      result: Controls,
      description: '读当前控件状态（模型、思考、姿态、计划、目标、上下文）',
    }),
    defineMethod({
      name: 'controls.setModel',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1), model: ModelRef }),
      result: Controls,
      description: '切换模型',
    }),
    defineMethod({
      name: 'controls.setThinking',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1), level: z.string().min(1) }),
      result: Controls,
      description: '切换思考档位',
    }),
    defineMethod({
      name: 'controls.setPosture',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1), posture: Posture }),
      result: Controls,
      description: '切换姿态（同时更新线程行）',
    }),
    defineMethod({
      name: 'controls.setPlanMode',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1), enabled: z.boolean() }),
      result: Controls,
      description: '开关计划模式',
    }),
    defineMethod({
      name: 'controls.setGoal',
      owner: 'core',
      /*
       * 目标正文非空**:空白也算空** —— 目标是一个要在达成前一直挂着的东西，一格空串会让
       * omp 建出一个没有 objective 的目标。校验放在契约层（唯一入口），引擎侧照收。
       */
      params: z.object({ threadId: z.string().min(1), goal: z.string().trim().min(1).nullable() }),
      result: Controls,
      description: '设置或清除目标；设置只改正文，进行中 / 已暂停保持不变（R-10）',
    }),
    defineMethod({
      name: 'controls.pauseGoal',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1) }),
      result: Controls,
      description: '暂停目标：这一轮照常跑完，之后不再计用量、不再给提示词注入目标上下文（R-10）',
    }),
    defineMethod({
      name: 'controls.resumeGoal',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1) }),
      result: Controls,
      description: '继续已暂停的目标（R-10）',
    }),

    defineMethod({
      name: 'interactions.list',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1) }),
      result: z.object({ interactions: z.array(Interaction) }),
      description: '列出待答交互',
    }),
    defineMethod({
      name: 'interactions.respond',
      owner: 'core',
      params: z.object({
        threadId: z.string().min(1),
        interactionId: z.string().min(1),
        answer: InteractionAnswer,
      }),
      result: empty,
      description: '回答一个交互',
    }),
  ],
  notifications: [
    defineNotification({ name: 'threads.updated', owner: 'core', params: Thread, description: '线程变化' }),
    defineNotification({
      name: 'threads.removed',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1) }),
      description: '线程被删除',
    }),
    defineNotification({ name: 'turns.state', owner: 'core', params: TurnState, description: '线程运行状态' }),
    defineNotification({
      name: 'submissions.changed',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1), submission: SubmissionView }),
      description: '一条提交的状态变了（Core 已存库的事实）',
    }),
    defineNotification({
      name: 'submissions.removed',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1), clientTurnId: z.string().min(1) }),
      description: '一条失败的提交被丢弃',
    }),
    defineNotification({
      name: 'turns.dropped',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1), clientTurnId: z.string().nullable(), text: z.string() }),
      description: 'omp 丢弃了一条用户输入',
    }),
    defineNotification({
      name: 'timeline.ops',
      owner: 'core',
      params: z.object({
        threadId: z.string().min(1),
        agentId: z.string().min(1),
        epoch: z.number().int().positive(),
        seq: z.number().int().positive(),
        ops: z.array(timelineOperationSchema),
      }),
      description: '时间线增量',
    }),
    defineNotification({
      name: 'timeline.reset',
      owner: 'core',
      params: z.object({
        threadId: z.string().min(1),
        agentId: z.string().min(1),
        epoch: z.number().int().positive(),
      }),
      description: '通道换 epoch，UI 必须整页重取',
    }),
    defineNotification({
      name: 'queue.changed',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1), queue: QueueSnapshot }),
      description: '队列变化',
    }),
    defineNotification({
      name: 'controls.changed',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1), controls: Controls }),
      description: '控件状态变化',
    }),
    /*
     * 上下文用量**单独一条通道**，不搭 controls.changed 那班车。
     *
     * 控件表是「模型 / 档位 / 姿态 / 模式」，用量是每轮都在涨的读数：搭同一班车意味着跑完一轮
     * 不重画，或者每轮重发一次整张控件表（含模型候选清单）。legacy 也是分开的两条
     * （bridge.ts 的 reselect 与 reportUsage），这里与它对齐。
     *
     * usage 可为 null：那是**一次有效报数**——「这条会话此刻没有可报的窗口」（换了没有窗口
     * 元数据的模型）与「还没报过」对屏幕是两件事，前者要收掉已经画出来的圆环。
     *
     * 名字落在 **controls** 名下而不是 usage：`usage.*` 是 usage 功能（用量统计）的命名空间，
     * 已由它的契约占用（contract-kit 的 composeContracts 判命名空间唯一）。上下文占用本来
     * 也就是 `controls.get` 报出来的那一格，归在 controls 名下与它同源。
     */
    defineNotification({
      name: 'controls.contextChanged',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1), usage: ContextUsage.nullable() }),
      description: '上下文用量变化',
    }),
    /*
     * 模型列表变了（装/卸服务商、启停模型）→ 入口页重新读一次草稿表（方案 §05）。
     * 它不带参数：草稿选择是**入口页本地**的，Core 不知道用户此刻在草稿里选了什么，
     * 所以只报「目录变了」，重读由入口页自己发起（带上它手里的草稿）。
     */
    defineNotification({
      name: 'controls.draftChanged',
      owner: 'core',
      params: empty,
      description: '可选模型或档位变了：入口页的草稿表需要重读',
    }),
    defineNotification({
      name: 'interactions.requested',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1), interaction: Interaction }),
      description: '引擎发起一个交互',
    }),
    defineNotification({
      name: 'interactions.resolved',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1), interactionId: z.string().min(1) }),
      description: '交互结束（回答或超时）',
    }),
  ],
  errors: conversationErrors,
})
