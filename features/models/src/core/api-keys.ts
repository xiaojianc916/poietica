import type { HostCaller } from '@poietica/core-kernel'
import { secretsContract } from '@poietica/feature-secrets/contract'
import type { Logger } from '@poietica/foundation'
import type { ApiKeyEntry, ModelsPort } from '@poietica/runtime-protocol'

/** 凭据库里服务商 API Key 那一格：键 = provider id，值 = key */
export const API_KEY_NAMESPACE = 'model-api-keys'

/** 服务商 API Key 的持久化（ADR-008）：落在 Host 的凭据库，Core 只在内存里拿着 */
export interface ApiKeyVault {
  all(): Promise<Record<string, string>>
  put(provider: string, key: string): Promise<void>
  delete(provider: string): Promise<void>
}

export function hostApiKeyVault(host: HostCaller): ApiKeyVault {
  return {
    all: async () => (await host.call(secretsContract, 'secrets.lease', { namespace: API_KEY_NAMESPACE })).entries,
    put: async (provider, key) => {
      await host.call(secretsContract, 'secrets.put', { namespace: API_KEY_NAMESPACE, key: provider, value: key })
    },
    delete: async (provider) => {
      await host.call(secretsContract, 'secrets.delete', { namespace: API_KEY_NAMESPACE, key: provider })
    },
  }
}

/**
 * 启动时把引擎落在磁盘上的明文 API Key 搬进凭据库，结果分两栏交回去：
 * - `moved`：搬进来了（引擎那边那一行随后被删掉）；
 * - `remaining`：**没搬动**，明文还在引擎的 agent.db 里。
 *
 * 搬不动（系统加密不可用、Host 不应答）时原样留着，宁可暂时还是旧样子，也不能把用户的钥匙弄丢；
 * 但这件事**必须能被看见** —— 组合根据此报一条 warn，审计页与诊断导出才说得出「本机还有明文凭据」。
 */
export interface AdoptApiKeysResult {
  readonly moved: readonly string[]
  readonly remaining: readonly string[]
  /** 凭据库里实际交回引擎的（只有名字） */
  readonly delivered: readonly string[]
}

export async function restoreApiKeys(d: {
  readonly vault: ApiKeyVault
  readonly models: ModelsPort
  readonly logger: Logger
}): Promise<AdoptApiKeysResult> {
  const moved: string[] = []
  const remaining: string[] = []
  for (const entry of await d.models.storedApiKeys()) {
    try {
      /* 逐家写：一家失败不影响别家；写完才算搬进来 */
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await d.vault.put(entry.provider, entry.key)
      moved.push(entry.provider)
    } catch (e) {
      remaining.push(entry.provider)
      d.logger.warn('legacy api key not moved to vault, left in engine store', {
        provider: entry.provider,
        error: String(e),
      })
    }
  }
  let leased: Record<string, string>
  try {
    leased = await d.vault.all()
  } catch (e) {
    d.logger.error('api keys could not be read from vault', { error: String(e) })
    return { moved, remaining, delivered: [] }
  }
  const entries: ApiKeyEntry[] = Object.entries(leased).map(([provider, key]) => ({ provider, key }))
  await d.models.loadApiKeys(entries)
  const delivered = entries.map((entry) => entry.provider)
  if (moved.length > 0) d.logger.info('legacy api keys moved to vault', { providers: moved })
  d.logger.info('api keys restored', { providers: delivered })
  return { moved, remaining, delivered }
}
