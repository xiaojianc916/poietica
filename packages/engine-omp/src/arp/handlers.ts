import { AppError, SystemErrorCode } from '@poietica/foundation'
import { jsonValue } from '@poietica/rpc'
import type { AgentEngine, EngineSession } from '@poietica/runtime-protocol'
import {
  type ArpEventParams,
  arpEngineCallParams,
  arpEngineRegisterToolParams,
  arpLoginAuthParams,
  arpLoginCancelParams,
  arpLoginParams,
  arpLoginProgressParams,
  arpLoginPromptParams,
  arpMethods,
  arpRunSubmitParams,
  arpSessionCallParams,
  arpSessionOpenParams,
  arpSessionPageParams,
} from '@poietica/runtime-protocol'
import { z } from 'zod'

/**
 * omp Runtime Worker 的 ARP 方法表：只做「参数校验 → 调 AgentEngine → 交回结果」，
 * 不持有 Core 的领域状态。会话事件经 `runtime.event` 原样流出，Worker 不认识产品投影。
 */
export interface ArpHandlersDeps {
  readonly engine: AgentEngine
  readonly emit: (p: ArpEventParams) => void
  /** Worker → Core 的反向请求；产品工具执行走它。 */
  readonly callCore: (method: string, params: unknown) => Promise<unknown>
}

export interface ArpHandlers {
  readonly handlers: Readonly<Record<string, (params: unknown) => unknown>>
  readonly dispose: () => Promise<void>
}

function parse<T>(schema: z.ZodType<T>, params: unknown): T {
  const result = schema.safeParse(params)
  if (!result.success) throw new AppError(SystemErrorCode.invalidParams, 'ARP 参数无效')
  return result.data
}

export function createArpHandlers(d: ArpHandlersDeps): ArpHandlers {
  const sessions = new Map<string, { session: EngineSession; dispose: () => void }>()
  const tools = new Map<string, { dispose: () => void }>()
  const logins = new Map<string, AbortController>()

  const close = async (key: string): Promise<void> => {
    const held = sessions.get(key)
    if (held === undefined) return
    sessions.delete(key)
    held.dispose()
    await held.session.dispose()
  }

  return {
    handlers: {
      [arpMethods.modelsLogin]: async (params) => {
        const input = parse(arpLoginParams, params)
        const controller = new AbortController()
        logins.set(input.loginId, controller)
        try {
          return await d.engine.models.login(input.providerId, {
            onAuth: (info) => {
              void d.callCore(arpMethods.loginAuth, parse(arpLoginAuthParams, { loginId: input.loginId, info }))
            },
            onProgress: (message) => {
              void d.callCore(
                arpMethods.loginProgress,
                parse(arpLoginProgressParams, { loginId: input.loginId, message }),
              )
            },
            onPrompt: async (prompt) => {
              const result = jsonValue(
                await d.callCore(
                  arpMethods.loginPrompt,
                  parse(arpLoginPromptParams, { loginId: input.loginId, prompt }),
                ),
              ) as { value: string }
              return result.value
            },
            signal: controller.signal,
          })
        } finally {
          logins.delete(input.loginId)
        }
      },
      [arpMethods.loginCancel]: (params) => {
        const input = parse(arpLoginCancelParams, params)
        logins.get(input.loginId)?.abort()
        return {}
      },
      [arpMethods.engineRegisterTool]: (params) => {
        const input = parse(arpEngineRegisterToolParams, params)
        tools.get(input.name)?.dispose()
        const disposable = d.engine.registerTool({
          name: input.name,
          label: input.label,
          description: input.description,
          parameters: z.record(z.string(), z.unknown()),
          parametersJsonSchema: input.parametersJsonSchema,
          approval: input.approval,
          ...(input.streamInput === undefined ? {} : { streamInput: input.streamInput }),
          execute: async (toolParams, ctx) => {
            const result = parse(
              z.object({ text: z.string(), details: z.unknown().optional(), isError: z.boolean().optional() }),
              jsonValue(
                await d.callCore(arpMethods.toolExecute, {
                  name: input.name,
                  params: toolParams,
                  cwd: ctx.cwd,
                  sessionKey: ctx.sessionKey,
                }),
              ),
            )
            return {
              text: result.text,
              ...(result.details === undefined ? {} : { details: result.details }),
              ...(result.isError === undefined ? {} : { isError: result.isError }),
            }
          },
        })
        tools.set(input.name, { dispose: () => disposable.dispose() })
        return {}
      },
      [arpMethods.engineUnregisterTool]: (params) => {
        const input = parse(z.object({ name: z.string().min(1) }), params)
        tools.get(input.name)?.dispose()
        tools.delete(input.name)
        return {}
      },
      [arpMethods.engineSnapshot]: () => ({
        groupOrder: [...d.engine.settings.groupOrder],
        browserRelay: d.engine.browserRelay(),
      }),
      [arpMethods.engineCall]: async (params) => {
        const input = parse(arpEngineCallParams, params)
        let target: unknown = d.engine
        for (const segment of input.path.slice(0, -1)) {
          if (typeof target !== 'object' || target === null) {
            throw new AppError(SystemErrorCode.methodNotFound, `ARP 路径不存在：${input.path.join('.')}`)
          }
          target = Reflect.get(target, segment)
        }
        const name = input.path.at(-1)!
        const method = typeof target === 'object' && target !== null ? Reflect.get(target, name) : undefined
        if (typeof method !== 'function') {
          throw new AppError(SystemErrorCode.methodNotFound, `ARP 方法不存在：${input.path.join('.')}`)
        }
        return (await Reflect.apply(method, target, input.args)) ?? {}
      },
      [arpMethods.sessionOpen]: async (params) => {
        const input = parse(arpSessionOpenParams, params)
        await close(input.key)
        const session = await d.engine.openSession({
          key: input.key,
          cwd: input.cwd,
          sessionFile: input.sessionFile,
          posture: input.posture,
          model: input.model,
          thinking: input.thinking,
          ...(input.autoTitle === undefined ? {} : { autoTitle: input.autoTitle }),
        })
        const subscription = session.subscribe((event) => d.emit({ key: input.key, event }))
        sessions.set(input.key, { session, dispose: () => subscription.dispose() })
        return { sessionId: session.sessionId, sessionFile: session.sessionFile }
      },
      [arpMethods.sessionPage]: async (params) => {
        const input = parse(arpSessionPageParams, params)
        const held = sessions.get(input.key)
        if (held === undefined) throw new AppError(SystemErrorCode.notFound, `会话未打开：${input.key}`)
        return held.session.page(
          input.agentId,
          input.beforeTurnId,
          input.throughTurnId === undefined ? undefined : { throughTurnId: input.throughTurnId },
        )
      },
      [arpMethods.sessionSnapshot]: async (params) => {
        const input = parse(arpSessionOpenParams.pick({ key: true }), params)
        const held = sessions.get(input.key)
        if (held === undefined) throw new AppError(SystemErrorCode.notFound, `会话未打开：${input.key}`)
        return {
          state: held.session.state(),
          busy: held.session.isBusy(),
          queue: held.session.queue(),
          controls: held.session.controls(),
          interactions: held.session.interactions(),
        }
      },
      [arpMethods.sessionCall]: async (params) => {
        const input = parse(arpSessionCallParams, params)
        if (input.method === 'subscribe' || input.method === 'dispose') {
          throw new AppError(SystemErrorCode.invalidParams, `session.call 不接受 ${input.method}`)
        }
        const held = sessions.get(input.key)
        if (held === undefined) throw new AppError(SystemErrorCode.notFound, `会话未打开：${input.key}`)
        const method = Reflect.get(held.session, input.method)
        if (typeof method !== 'function') {
          throw new AppError(SystemErrorCode.methodNotFound, `会话方法不存在：${input.method}`)
        }
        return (await Reflect.apply(method, held.session, input.args)) ?? {}
      },
      [arpMethods.runSubmit]: async (params) => {
        const input = parse(arpRunSubmitParams, params)
        const held = sessions.get(input.key)
        if (held === undefined) throw new AppError(SystemErrorCode.notFound, `会话未打开：${input.key}`)
        await held.session.submit({
          text: input.text,
          images: input.images,
          files: input.files,
          skills: input.skills,
          deliverAs: input.deliverAs,
          ...(input.ref === undefined ? {} : { ref: input.ref }),
          ...(input.context === undefined ? {} : { context: input.context }),
        })
        return {}
      },
      [arpMethods.runCancel]: async (params) => {
        const input = parse(arpSessionOpenParams.pick({ key: true }), params)
        const held = sessions.get(input.key)
        if (held === undefined) throw new AppError(SystemErrorCode.notFound, `会话未打开：${input.key}`)
        await held.session.cancel()
        return {}
      },
      [arpMethods.sessionClose]: async (params) => {
        const input = parse(arpSessionOpenParams.pick({ key: true }), params)
        await close(input.key)
        return {}
      },
    },
    async dispose() {
      for (const login of logins.values()) login.abort()
      logins.clear()
      for (const tool of tools.values()) tool.dispose()
      tools.clear()
      await Promise.all([...sessions.keys()].map((key) => close(key)))
    },
  }
}
