import type { TranscriptInteraction, TranscriptItem, TranscriptTurn } from '@poietica/transcript'
import {
  agentTranscriptSnapshotSchema,
  type TranscriptOperation,
  type TranscriptPage,
  type TurnHeader,
  transcriptItemSchema,
  transcriptOperationSchema,
} from '@poietica/transcript'
import { z } from 'zod'

/*
 * 线上形状（05 页 §12）与内存形状之间唯一的一处加宽。
 *
 * 快照的**形状**就是 @poietica/transcript 的 TranscriptPage（三个进程共用的一份模型，05 页 §12.1）。
 * 下面的 `pageSchema` 在运行时用上游的 zod 校验，但把编译期类型钉回 TranscriptPage —— zod 的推断在
 * exactOptionalPropertyTypes 之下会把可选字段放宽成 `?: T | undefined`，而线上跑的就是同一份 JSON，
 * 这里要声明的是那一份。
 */
/*
 * 快照那一份也要线上加宽（与 `turn.upsert` 同一条理由）：
 *
 * 「Core 即时回显」要求实时推送与**快照**都给 turn 带上 `clientTurnId`（提交号）——
 * 界面靠它把「提交行」换成真实 turn。上游的 `TranscriptTurn` 没有这个字段，改它就
 * 违反了「src/upstream/ 与 legacy 逐字节相同」，所以加宽落在这一层。
 *
 * 编译期类型也跟着放宽：turn 条目多一个可选 `clientTurnId`。
 */
export type WireTranscriptTurn = TranscriptTurn & { readonly clientTurnId?: string }
export type WireTranscriptPage = Omit<TranscriptPage, 'items'> & {
  readonly items: readonly (TranscriptItem | WireTranscriptTurn)[]
}

/*
 * 运行时也要**保留** `clientTurnId`：zod 的 object 默认把未知键剥掉，只放宽编译期类型
 * 是不够的（实测：快照过了契约的那一层，turn 上的号就被剥没了，界面再也合不上）。
 * 做法与下面的 `timelineOperationSchema` 逐字同形：把 item 联合里 turn 那一支 extend 一下。
 */
export const pageSchema = (() => {
  const options = (transcriptItemSchema as unknown as { options: readonly z.ZodObject[] }).options
  /* items 是**数组**：漏掉 z.array 会让契约在收端报 "expected object, received array"（实测）。 */
  const items = z.array(
    z.discriminatedUnion(
      'kind',
      options.map((option) => {
        const kind = (option.shape.kind as unknown as { value?: string } | undefined)?.value
        return kind === 'turn' ? option.extend({ clientTurnId: z.string().min(1).optional() }) : option
      }) as never,
    ),
  )
  return (agentTranscriptSnapshotSchema as unknown as z.ZodObject).extend({
    items,
  }) as unknown as z.ZodType<WireTranscriptPage>
})()

/**
 * 05 页 §12.2 要求 Core 把 UI 提交时给的 `clientTurnId` 写进 `turn.upsert` 的 `clientTurnId` 字段
 * （UI 靠它把乐观消息换成真实那一轮）。上游的 `TranscriptTurn` 没有这个字段 —— 它是新架构一致性
 * 协议的一部分、不是对话内容，所以加在**线上形状**这一层：src/upstream/ 与 legacy 逐字节相同
 * （11 页 P1.4 的验收要求）。其余 op 的形状与校验原样从上游派生，不抄第二份。
 */
export type WireTranscriptOperation =
  | Exclude<TranscriptOperation, { op: 'turn.upsert' }>
  | { readonly op: 'turn.upsert'; readonly turn: TurnHeader & { readonly clientTurnId?: string } }

/**
 * 交互那一格也是一处加宽：产品的交互有五支（approval / question / select / input / confirm / plan），
 * 而 transcript 的 `interactionKind` 只认 approval / question 两档（它是从 legacy 逐字节迁来的）。
 *
 * 计划卡片要在时间线上有一席之地（04 页 §3.12 第 5 支），所以线上这一层把 `plan` 放出来；
 * 上游那一份照旧不动（P1.4 要求 `src/upstream/` 与 legacy 逐字节相同），规则与 `clientTurnId` 同此。
 */
export const WireInteractionKind = z.enum(['approval', 'question', 'plan'])
export type WireInteractionKind = z.infer<typeof WireInteractionKind>

export type WireTranscriptInteraction = Omit<TranscriptInteraction, 'interactionKind'> & {
  readonly interactionKind: WireInteractionKind
}

export const timelineOperationSchema = (() => {
  const options = (transcriptOperationSchema as unknown as { options: readonly z.ZodObject[] }).options
  return z.discriminatedUnion(
    'op',
    options.map((option) => {
      const op = (option.shape.op as unknown as { value?: string } | undefined)?.value
      if (op === 'interaction.upsert') return widenInteractionKind(option)
      if (op !== 'turn.upsert') return option
      const turn = option.shape.turn as unknown as z.ZodObject
      return option.extend({ turn: turn.extend({ clientTurnId: z.string().min(1).optional() }) })
    }) as never,
  ) as unknown as z.ZodType<WireTranscriptOperation>
})()

/** 把 `interaction.upsert` 那一支的 `interactionKind` 放宽到三档（approval / question / plan）。 */
function widenInteractionKind(option: z.ZodObject): z.ZodObject {
  const interaction = option.shape.interaction as unknown as z.ZodObject
  return option.extend({ interaction: interaction.extend({ interactionKind: WireInteractionKind }) })
}
