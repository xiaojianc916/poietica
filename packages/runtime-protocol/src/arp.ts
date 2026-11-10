import { z } from 'zod'
import { Controls, Interaction, QueueSnapshot, SessionState } from './values'

/**
 * ARP：Core 与 omp Runtime Worker 之间的内部协议（架构设计 §8）。
 *
 * 只因为进程边界才存在：故障隔离与沙箱。方法形状贴着 omp 的会话 API，不做引擎抽象；
 * 协议版本只用来检测「半更新」，不一致就重启 Worker。这里先放握手与生命周期，
 * 会话/Run/审批方法随 Worker 外壳一起长。
 */
export const ARP_VERSION = 1

export const arpMethods = {
  hello: 'runtime.hello',
  ping: 'runtime.ping',
  shutdown: 'runtime.shutdown',
  sessionOpen: 'session.open',
  sessionClose: 'session.close',
  sessionPage: 'session.page',
  sessionSnapshot: 'session.snapshot',
  sessionCall: 'session.call',
  runSubmit: 'run.submit',
  runCancel: 'run.cancel',
} as const

export const arpHelloParams = z.object({
  protocolVersion: z.number().int().positive(),
  coreVersion: z.string().min(1),
})
export type ArpHelloParams = z.infer<typeof arpHelloParams>

export const arpHelloResult = z.object({
  protocolVersion: z.number().int().positive(),
  runtimeVersion: z.string().min(1),
  engineVersion: z.string().min(1),
  /** 8.2 表里这一版 Worker 实际注册的方法组，Core 据此判断能力是否齐全。 */
  capabilities: z.array(z.string().min(1)),
})
export type ArpHelloResult = z.infer<typeof arpHelloResult>

export const arpPingResult = z.object({ at: z.string() })
export type ArpPingResult = z.infer<typeof arpPingResult>

export const arpErrors = {
  protocolMismatch: 'runtime.protocol_mismatch',
  protocolUnsupported: 'runtime.protocol_unsupported',
} as const

/* ── 会话与 Run（P3 第一批只定形状，Worker 逐组实现） ─────────────────── */

export const arpSessionOpenParams = z.object({
  key: z.string().min(1),
  cwd: z.string().min(1),
  sessionFile: z.string().min(1).nullable(),
  posture: z.enum(['ask', 'auto-edit', 'full-access']),
  model: z.object({ provider: z.string().min(1), id: z.string().min(1) }).nullable(),
  thinking: z.string().min(1).nullable(),
  autoTitle: z.boolean().optional(),
})
export type ArpSessionOpenParams = z.infer<typeof arpSessionOpenParams>

export const arpSessionOpenResult = z.object({
  sessionId: z.string().min(1),
  sessionFile: z.string().min(1),
})
export type ArpSessionOpenResult = z.infer<typeof arpSessionOpenResult>

export const arpSessionPageParams = z.object({
  key: z.string().min(1),
  agentId: z.string().min(1),
  beforeTurnId: z.string().min(1).nullable(),
  throughTurnId: z.string().min(1).optional(),
})
export type ArpSessionPageParams = z.infer<typeof arpSessionPageParams>

export const arpRunSubmitParams = z.object({
  key: z.string().min(1),
  text: z.string(),
  images: z.array(z.object({ path: z.string().min(1), mime: z.string().min(1) })),
  files: z.array(z.object({ path: z.string().min(1), name: z.string().min(1) })),
  skills: z.array(z.string()),
  deliverAs: z.enum(['turn', 'steer', 'followUp']),
  ref: z.string().optional(),
  context: z.array(z.object({ source: z.string().min(1), text: z.string() })).optional(),
})
export type ArpRunSubmitParams = z.infer<typeof arpRunSubmitParams>

export const arpEventParams = z.object({ key: z.string().min(1), event: z.unknown() })
export type ArpEventParams = z.infer<typeof arpEventParams>
export const arpEventMethod = 'runtime.event'

export const arpSessionSnapshotResult = z.object({
  state: SessionState,
  busy: z.boolean(),
  queue: QueueSnapshot,
  controls: Controls,
  interactions: z.array(Interaction),
})
export type ArpSessionSnapshotResult = z.infer<typeof arpSessionSnapshotResult>

export const arpSessionCallParams = z.object({
  key: z.string().min(1),
  method: z.string().min(1),
  args: z.array(z.unknown()),
})
export type ArpSessionCallParams = z.infer<typeof arpSessionCallParams>
