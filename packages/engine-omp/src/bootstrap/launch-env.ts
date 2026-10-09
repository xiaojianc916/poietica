import { ISOLATION_ENV_KEYS } from './isolation-env'

/**
 * 启动环境快照：captureLaunchEnv() 必须是 Core 的 main.ts 的第一条语句，
 * 它记下“用户真实环境”有哪些键；scrubInjected() 在 pi-utils 触发 .env 加载之后调用，
 * 把那时才出现的新键删掉。这样 .env 里的东西永远进不了 omp 的进程环境（12 页 §4.2）。
 */
let snapshot: ReadonlySet<string> | null = null

export interface LaunchEnv {
  readonly keys: readonly string[]
  /**
   * 先导入 pi-utils（它在求值时加载 .env），再删除快照之后新出现的键与 omp 认可的环境凭据键；
   * 返回被删除的**键名**（绝不返回值）。
   *
   * 触发 .env 加载的这次导入只能写在这里：`apps/core` 不得 import `@oh-my-pi/*`
   * （03 页 §9 的 omp-confined；04 页 §3.2 第 5 步因此收进本方法）。
   *
   * 隔离变量的键**永远不删**：它们是在快照之后由 prepareIsolation 写进去的，不是注入；
   * 删掉会让 natives 加载器回落到 ~/.omp（XDG_DATA_HOME 就是被这一条误伤过）。
   */
  scrubInjected(): Promise<readonly string[]>
}

export function captureLaunchEnv(env: Record<string, string | undefined> = process.env): LaunchEnv {
  const keys = new Set(Object.keys(env))
  snapshot = keys
  return {
    keys: [...keys],
    async scrubInjected() {
      /*
       * 第 1 步：触发 pi-utils 的 .env 加载（它在模块求值时把 .env 灌进 process.env）。
       * 必须先于下面的删除 —— 否则这一轮注入的键会留在环境里进了 omp（04 页 §3.3 第 7 条）。
       */
      await import('@oh-my-pi/pi-utils')
      const removed: string[] = []
      const kept = new Set(ISOLATION_ENV_KEYS)
      for (const key of Object.keys(env)) {
        if (!keys.has(key) && !kept.has(key)) {
          delete env[key]
          removed.push(key)
        }
      }
      // omp 自己认可的 provider 环境变量：.env 里写 ANTHROPIC_API_KEY 也会被 pi-ai 认出来，
      // 所以按 provider 清单逐个删（12 页 §4.2 第 2 条）
      const api = (await import('@oh-my-pi/pi-ai')) as {
        listProvidersWithEnvKey?: () => string[]
        getEnvApiKeyName?: (provider: string) => string | null
      }
      if (typeof api.listProvidersWithEnvKey === 'function' && typeof api.getEnvApiKeyName === 'function') {
        for (const provider of api.listProvidersWithEnvKey()) {
          const name = api.getEnvApiKeyName(provider)
          if (name !== null && !kept.has(name) && env[name] !== undefined) {
            delete env[name]
            removed.push(name)
          }
        }
      }
      return Object.freeze(removed)
    },
  }
}

/** 测试与诊断用：本次进程是否已经快照过 */
export function hasLaunchEnvSnapshot(): boolean {
  return snapshot !== null
}
