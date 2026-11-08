import type { HostCaller } from '@poietica/core-kernel'
import type { ApiKeyEntry, ModelsPort } from '@poietica/engine'
import { secretsContract } from '@poietica/feature-secrets/contract'
import type { Logger } from '@poietica/foundation'

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
 * 把引擎落在磁盘上的明文 API Key 搬进凭据库（v0.5.20 及以前的 setApiKey、omp 的「浏览器授权换钥匙」登录都会留下），
 * 再把凭据库里的全部钥匙交给引擎的内存层；交过去的那一家，引擎会删掉磁盘上的旧行。
 *
 * 搬不进去（系统加密不可用、Host 不应答）的那几家**原样留在引擎那里**：宁可暂时还是旧样子，也不能把用户的钥匙弄丢。
 * 返回搬进去的服务商（只有名字）。
 */
export async function restoreApiKeys(d: {
  readonly vault: ApiKeyVault
  readonly models: ModelsPort
  readonly logger: Logger
}): Promise<readonly string[]> {
  const moved: string[] = []
  for (const entry of await d.models.storedApiKeys()) {
    try {
      /* 逐家写：一家失败不影响别家；写完才算搬进来 */
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await d.vault.put(entry.provider, entry.key)
      moved.push(entry.provider)
    } catch (e) {
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
    return moved
  }
  const entries: ApiKeyEntry[] = Object.entries(leased).map(([provider, key]) => ({ provider, key }))
  await d.models.loadApiKeys(entries)
  if (moved.length > 0) d.logger.info('legacy api keys moved to vault', { providers: moved })
  d.logger.info('api keys restored', { providers: entries.map((e) => e.provider) })
  return moved
}
