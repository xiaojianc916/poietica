import { AppError, SystemErrorCode } from '@poietica/foundation'
import { z } from 'zod'
import type { Contract } from './define'
import { systemContract } from './system'
import type { AnyMethod, AnyNotification } from './types'

export interface AppContract {
  readonly contracts: readonly Contract[]
  readonly methods: ReadonlyMap<string, AnyMethod>
  readonly notifications: ReadonlyMap<string, AnyNotification>
  readonly errorMessages: Readonly<Record<string, string>>
}

const NAME = /^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)+$/
const ERROR = /^[a-z][a-z-]*\.[a-z][a-z0-9_]*$/

/** 汇总全部契约并做静态校验；任何违规直接抛错（契约快照测试会第一时间发现）。 */
export function composeContracts(...contracts: readonly Contract[]): AppContract {
  const all = [systemContract, ...contracts]
  const ids = new Set<string>()
  const nsOwner = new Map<string, string>()
  const methods = new Map<string, AnyMethod>()
  const notifications = new Map<string, AnyNotification>()
  const errorMessages: Record<string, string> = {}
  const fail = (msg: string): never => {
    throw new AppError(SystemErrorCode.contractInvalid, msg)
  }
  for (const c of all) {
    if (ids.has(c.id)) fail(`契约 id 重复：${c.id}`)
    ids.add(c.id)
    for (const ns of c.namespaces) {
      const prev = nsOwner.get(ns)
      if (prev !== undefined) fail(`命名空间 ${ns} 同时属于 ${prev} 和 ${c.id}`)
      nsOwner.set(ns, c.id)
    }
    for (const m of c.methods) {
      if (!NAME.test(m.name)) fail(`方法名不合法：${m.name}`)
      if (!c.namespaces.includes(m.name.split('.')[0]!)) fail(`${m.name} 不属于 ${c.id} 的命名空间`)
      if (methods.has(m.name) || notifications.has(m.name)) fail(`名字重复：${m.name}`)
      methods.set(m.name, m)
    }
    for (const n of c.notifications) {
      if (!NAME.test(n.name)) fail(`通知名不合法：${n.name}`)
      if (!c.namespaces.includes(n.name.split('.')[0]!)) fail(`${n.name} 不属于 ${c.id} 的命名空间`)
      if (methods.has(n.name) || notifications.has(n.name)) fail(`名字重复：${n.name}`)
      notifications.set(n.name, n)
    }
    for (const [code, msg] of Object.entries(c.errors.__messages)) {
      if (!ERROR.test(code)) fail(`错误码不合法：${code}`)
      if (code.split('.')[0] !== (c.id === 'system' ? 'kernel' : c.id)) fail(`错误码 ${code} 的前缀必须是 ${c.id}`)
      errorMessages[code] = msg
    }
  }
  return Object.freeze({ contracts: all, methods, notifications, errorMessages: Object.freeze(errorMessages) })
}

/**
 * 生成稳定的契约快照（JSON 文本，末尾带换行）。内容：每个方法的名字、owner、timeoutMs、说明、
 * params（输入形态）与 result（输出形态）的 JSON Schema；每个通知的名字、owner、说明、params；全部错误码与默认文案。
 * 全部按名字排序，所以契约不变时输出逐字节不变。protocol 包的快照测试比对它（05 页 §8）。
 */
export function contractSnapshot(app: AppContract): string {
  const toSchema = (schema: z.ZodType, io: 'input' | 'output'): unknown =>
    z.toJSONSchema(schema, { io, unrepresentable: 'any' })
  const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const methods = [...app.methods.values()].sort(byName).map((m) => ({
    name: m.name,
    owner: m.owner,
    timeoutMs: m.timeoutMs,
    description: m.description,
    params: toSchema(m.params, 'input'),
    result: toSchema(m.result, 'output'),
  }))
  const notifications = [...app.notifications.values()].sort(byName).map((n) => ({
    name: n.name,
    owner: n.owner,
    description: n.description,
    params: toSchema(n.params, 'output'),
  }))
  const errors = Object.keys(app.errorMessages)
    .sort()
    .map((code) => ({ code, message: app.errorMessages[code] }))
  return `${JSON.stringify({ methods, notifications, errors }, null, 2)}\n`
}
