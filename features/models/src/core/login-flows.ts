import type { LoginIO, ModelsPort } from '@poietica/engine'
import { AppError, createId, type Logger, SystemErrorCode } from '@poietica/foundation'
import type { LoginEvent } from '../contract'
import { modelsErrors } from '../contract/errors'

export interface LoginFlowsDeps {
  readonly models: Pick<ModelsPort, 'login'>
  readonly logger: Logger
  readonly emit: (loginId: string, event: LoginEvent) => void
  readonly emitChanged: () => void
}

interface Flow {
  readonly abort: AbortController
  readonly prompts: Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>
}

/**
 * 进行中的订阅登录。流程本身全在 omp（AuthStorage.oauth.login）：这里只把它的回调翻成通知、把界面填的格子按 promptId 交回去，
 * 不碰 token —— 凭据由 omp 落进 agent.db，结局只报身份（邮箱 / 组织名）。
 */
export class LoginFlows {
  readonly #flows = new Map<string, Flow>()

  constructor(private readonly d: LoginFlowsDeps) {}

  start(providerId: string): string {
    const loginId = createId()
    const flow: Flow = { abort: new AbortController(), prompts: new Map() }
    this.#flows.set(loginId, flow)
    const io: LoginIO = {
      onAuth: (info) => this.d.emit(loginId, { kind: 'auth', ...info }),
      onProgress: (message) => this.d.emit(loginId, { kind: 'progress', message }),
      onPrompt: (prompt) =>
        new Promise<string>((resolve, reject) => {
          if (flow.abort.signal.aborted) {
            reject(new AppError(SystemErrorCode.cancelled, '登录已取消'))
            return
          }
          const promptId = createId()
          flow.prompts.set(promptId, { resolve, reject })
          this.d.emit(loginId, { kind: 'prompt', promptId, ...prompt })
        }),
      signal: flow.abort.signal,
    }
    void this.d.models
      .login(providerId, io)
      .then((identity) => {
        this.d.logger.info('subscription login done', { provider: providerId })
        this.d.emit(loginId, { kind: 'done', identity })
        this.d.emitChanged()
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)
        this.d.logger.warn('subscription login failed', { provider: providerId, error: reason })
        this.d.emit(loginId, { kind: 'failed', message: flow.abort.signal.aborted ? '登录已取消' : reason })
      })
      .finally(() => {
        this.#settle(loginId, flow)
      })
    return loginId
  }

  answer(loginId: string, promptId: string, value: string): void {
    const pending = this.#require(loginId).prompts.get(promptId)
    if (pending === undefined) throw new AppError(modelsErrors.login_not_found, '这一格已经答过或不存在')
    this.#require(loginId).prompts.delete(promptId)
    pending.resolve(value)
  }

  cancel(loginId: string): void {
    const flow = this.#flows.get(loginId)
    if (flow === undefined) return
    flow.abort.abort()
    for (const pending of flow.prompts.values()) pending.reject(new AppError(SystemErrorCode.cancelled, '登录已取消'))
    flow.prompts.clear()
  }

  dispose(): void {
    for (const loginId of [...this.#flows.keys()]) this.cancel(loginId)
  }

  #require(loginId: string): Flow {
    const flow = this.#flows.get(loginId)
    if (flow === undefined) throw new AppError(modelsErrors.login_not_found, '这次登录已经结束或不存在')
    return flow
  }

  #settle(loginId: string, flow: Flow): void {
    for (const pending of flow.prompts.values()) pending.reject(new AppError(SystemErrorCode.cancelled, '登录已结束'))
    this.#flows.delete(loginId)
  }
}
