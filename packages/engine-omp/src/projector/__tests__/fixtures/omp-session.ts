import '../../../__tests__/omp-home'

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import type { EngineSession, EngineSessionEvent, OpenSessionSpec } from '@poietica/engine'
import { type Logger, noopLogger } from '@poietica/foundation'
import { wrapOmpSession } from '../../../omp-session-adapter'

/*
 * 一个假的 omp AgentSession：只实现 wrapOmpSession 真正用到的那几格（OmpAgentSessionLike），
 * 并把订阅回调抓在手里，让测试自己放帧。
 *
 * 它存在的理由与 legacy 的 SDK 原型拦截同一条：真起一条会话要模型与密钥，而这里要证的只是
 * 「桥把哪一格读成什么」（12 页 §12.3）。事件形状照 docs/omp-sdk-reference.md 的 AgentSessionEvent 抄。
 */

export interface DeliveredCall {
  readonly how: 'prompt' | 'customMessage' | 'steer' | 'followUp'
  readonly text: string
}

export interface FakeSession {
  readonly session: EngineSession
  /** 把一帧交给适配器（真实那一份由 omp 的 agent loop 推） */
  feed(event: Record<string, unknown>): void
  /** 投递出去的那几次调用，按顺序 */
  readonly calls: DeliveredCall[]
  /** 适配器收到的全部事件，按顺序（判断 timelineReset 之类的副作用） */
  readonly events: EngineSessionEvent[]
}

export interface FakeSessionOptions {
  readonly spec?: Partial<OpenSessionSpec>
  readonly thinking?: string | null
  readonly thinkingLevels?: readonly string[]
  readonly skills?: readonly { readonly name: string }[]
  readonly logger?: Logger
}

/**
 * 会话里那个技能的 SKILL.md（临时目录，进程内建一次）。
 *
 * 技能展开走的是 omp 官方的 `buildSkillPromptMessage` —— 它要读盘，所以夹具必须给一份
 * 真的 SKILL.md 与真的 baseDir，而不是只有名字的空壳（12 页 §7.6）。
 */
const SKILL_DIR = path.join(tmpdir(), 'poietica-fixture-skill-review')
const SKILL_FILE = path.join(SKILL_DIR, 'SKILL.md')
if (!existsSync(SKILL_FILE)) {
  mkdirSync(SKILL_DIR, { recursive: true })
  writeFileSync(SKILL_FILE, '---\nname: review\ndescription: fixture skill\n---\n夹具技能的正文。\n')
}

const BASE_SPEC: OpenSessionSpec = {
  key: 'fake-omp',
  cwd: 'C:\\work',
  sessionFile: null,
  posture: 'ask',
  model: null,
  thinking: null,
}

export async function fakeOmpSession(o: FakeSessionOptions = {}): Promise<FakeSession> {
  const listeners: ((event: Record<string, unknown>) => void)[] = []
  const calls: DeliveredCall[] = []
  const events: EngineSessionEvent[] = []
  const session = {
    sessionId: 'session-1',
    sessionFile: 'session-1.jsonl',
    settings: Settings.isolated(),
    messages: [],
    // 技能表带上 filePath / baseDir：官方那条展开路径要读 SKILL.md
    skills: (o.skills ?? []).map((skill) => ({ ...skill, filePath: SKILL_FILE, baseDir: SKILL_DIR })),
    subscribe(listener: (event: Record<string, unknown>) => void): () => void {
      listeners.push(listener)
      return () => undefined
    },
    prompt: async (text: string): Promise<boolean> => {
      calls.push({ how: 'prompt', text })
      return true
    },
    promptCustomMessage: async (message: Record<string, unknown>): Promise<boolean> => {
      calls.push({ how: 'customMessage', text: textOfContent(message.content) })
      return true
    },
    steer: async (text: string): Promise<void> => {
      calls.push({ how: 'steer', text })
    },
    followUp: async (text: string): Promise<void> => {
      calls.push({ how: 'followUp', text })
    },
    abort: async (): Promise<void> => undefined,
    dispose: async (): Promise<void> => undefined,
    setPromptDropped: (): void => undefined,
    setThinkingLevel: (): void => undefined,
    setSteeringMode: (): void => undefined,
    setFollowUpMode: (): void => undefined,
    getQueuedMessages: () => ({ steering: [], followUp: [] }),
    removeQueuedMessage: () => false,
    getContextUsage: () => undefined,
    getLastAssistantMessage: () => undefined,
    getAvailableThinkingLevels: () => o.thinkingLevels ?? [],
  }
  const engineSession = await wrapOmpSession({
    spec: { ...BASE_SPEC, ...o.spec },
    settings: session.settings,
    agentSession: session,
    setToolUIContext: () => undefined,
    mcpManager: null,
    tools: new Map(),
    logger: o.logger ?? noopLogger,
    subagentBus: null,
    initializeExtensions: async () => undefined,
    /* 这套夹具只证「桥读了哪一格」，模型目录一律空表：退回 provider/id 与空梯子 */
    modelCatalog: () => null,
    model: null,
    thinking: o.thinking ?? null,
  })
  engineSession.subscribe((event) => events.push(event))
  return {
    session: engineSession,
    feed: (event) => {
      for (const listener of listeners) listener(event)
    },
    calls,
    events,
  }
}

/** 事件流里所有 timeline 的 ops，按到达顺序摊平 */
export function opsOf(events: readonly EngineSessionEvent[]): readonly Record<string, unknown>[] {
  return events.flatMap((event) =>
    event.type === 'timeline' ? (event.ops as unknown as Record<string, unknown>[]) : [],
  )
}

/**
 * 自定义消息的正文。omp 的 `CustomMessage.content` 是「文本块 + 图片」的联合数组
 * （与 prompt() 收裸字符串两条签名不一样），所以这里按文本块拼一次 —— legacy 的
 * `textOf` 也是这么读的。
 */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((block) => {
      const entry = block as { readonly type?: unknown; readonly text?: unknown }
      return entry.type === 'text' && typeof entry.text === 'string' ? [entry.text] : []
    })
    .join('\n')
}
