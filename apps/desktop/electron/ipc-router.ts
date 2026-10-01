/*
 * 主进程侧的传输：{ command, args } 进，{ ok } | { error } 出。
 *
 * 这个文件不 import electron：自检要在纯 Node 里直接跑它，import 了就跑不动。
 * 失败时 reject 的是 Problem 裸对象（形状正本 packages/problem/src/model.ts），
 * 因为 packages/problem/src/problem.ts 的 isProblem 按形状认它 —— 折成 Error 就丢了
 * userMessageKey 与 details。IPC 那条线的 Error 由主进程另配（见 main.ts 的 reply）。
 */

export interface RouterDeps {
  native: { invoke(command: string, argsJson: string): Promise<string> }
}

export interface Router {
  invoke(command: unknown, args: unknown): Promise<unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 失败原因要带上码：Electron 的 IPC 会把异常压成一句 message，码是那时唯一还在的信息。 */
function failure(problem: unknown): Error {
  const code =
    isRecord(problem) && typeof problem['code'] === 'string' ? problem['code'] : 'unknown'

  return new Error(`poietica: ${code}`)
}

export function createRouter(deps: RouterDeps): Router {
  return {
    /** 渲染层是不可信输入：命令名与参数在这里就挡住，不送进原生再报错。 */
    async invoke(command, args) {
      if (typeof command !== 'string' || command.length === 0) {
        throw new Error('poietica: requestInvalid — 命令名必须是非空字符串')
      }

      if (args !== undefined && args !== null && !isRecord(args)) {
        throw new Error('poietica: requestInvalid — 参数必须是对象或 null')
      }

      const raw = await deps.native.invoke(command, JSON.stringify(args ?? {}))
      let envelope: unknown

      try {
        envelope = JSON.parse(raw)
      } catch (cause) {
        throw new Error(`poietica: contractDecodeFailed — 原生应答不是 JSON：${raw}`, { cause })
      }

      if (isRecord(envelope) && 'ok' in envelope) {
        return envelope['ok']
      }

      if (isRecord(envelope) && 'error' in envelope) {
        const problem = envelope['error']

        throw Object.assign(failure(problem), { problem })
      }

      throw new Error(`poietica: contractDecodeFailed — 原生应答不是 ok/error 信封：${raw}`)
    },
  }
}
