import type { HostCaller } from '@poietica/core-kernel'
import type { SettingsPort } from '@poietica/engine'
import { secretsContract } from '@poietica/feature-secrets/contract'
import type { Logger } from '@poietica/foundation'

/** 凭据库里 omp 凭据类设置那一格：键 = 设置路径（例如 `hindsight.apiToken`） */
export const SECRET_SETTINGS_NAMESPACE = 'omp-settings'

/** 凭据类设置的持久化（ADR-008）：落在 Host 的凭据库，引擎只拿到运行时覆盖层里的那一份 */
export interface SecretSettingsVault {
  all(): Promise<Record<string, string>>
  put(path: string, value: string): Promise<void>
  delete(path: string): Promise<void>
}

export function hostSecretSettingsVault(host: HostCaller): SecretSettingsVault {
  const namespace = SECRET_SETTINGS_NAMESPACE
  return {
    all: async () => (await host.call(secretsContract, 'secrets.lease', { namespace })).entries,
    put: async (path, value) => {
      await host.call(secretsContract, 'secrets.put', { namespace, key: path, value })
    },
    delete: async (path) => {
      await host.call(secretsContract, 'secrets.delete', { namespace, key: path })
    },
  }
}

/**
 * 启动时：config.yml 里旧版留下的明文凭据先搬进凭据库、再从 config.yml 删掉；然后把凭据库里的每一格注入引擎的
 * 运行时覆盖层。搬不进去的（系统加密不可用、Host 不应答）原样留在 config.yml —— 不能把用户的令牌弄丢。
 */
export async function restoreSecretSettings(d: {
  readonly vault: SecretSettingsVault
  readonly settings: SettingsPort
  readonly logger: Logger
}): Promise<void> {
  const moved: string[] = []
  for (const stored of await d.settings.storedSecrets()) {
    try {
      /* 逐格搬：一格失败不影响别格；先写进凭据库，成功了才删 config.yml 里的那份 */
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await d.vault.put(stored.path, stored.value)
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await d.settings.reset(stored.path)
      moved.push(stored.path)
    } catch (e) {
      d.logger.warn('legacy secret setting not moved to vault', { path: stored.path, error: String(e) })
    }
  }
  if (moved.length > 0) d.logger.info('legacy secret settings moved to vault', { paths: moved })
  let leased: Record<string, string>
  try {
    leased = await d.vault.all()
  } catch (e) {
    d.logger.error('secret settings could not be read from vault', { error: String(e) })
    return
  }
  for (const [path, value] of Object.entries(leased)) {
    try {
      /* 每格一次覆盖，互不依赖，但都只是改内存里的一层 */
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await d.settings.injectSecret(path, value)
    } catch (e) {
      /* omp 换版本后这一格可能不存在了：跳过，不挡其它格 */
      d.logger.warn('secret setting not injected', { path, error: String(e) })
    }
  }
}
