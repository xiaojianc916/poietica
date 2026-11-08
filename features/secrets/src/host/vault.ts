import { AppError, type Logger } from '@poietica/foundation'
import { createJsonDocument } from '@poietica/fs-kit'
import { z } from 'zod'
import { secretsErrors } from '../contract/errors'

/** 加解密的那一层（生产是 Electron safeStorage；测试注入） */
export interface SecretCipher {
  /** 系统加密此刻能不能用（Windows 上即 DPAPI；Linux 上只有明文兜底时算不能用） */
  available(): boolean
  /** 明文 → base64 密文 */
  encrypt(plain: string): string
  /** base64 密文 → 明文；换了机器 / 换了 Windows 账户就会抛 */
  decrypt(cipherText: string): string
}

/** 落盘的形状：只有密文。版本号留给将来换格式 */
const VaultFile = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), z.record(z.string(), z.string())),
})
type VaultFile = z.infer<typeof VaultFile>

export interface SecretVault {
  lease(namespace: string): Promise<Record<string, string>>
  put(namespace: string, key: string, value: string): Promise<void>
  delete(namespace: string, key: string): Promise<void>
}

/**
 * 凭据库：一个 JSON 文件，`entries[命名空间][键] = 密文`。写前必须确认系统加密可用 —— 不可用就报错，
 * 绝不退回明文（ADR-008）。读时解不开的条目（换了机器 / 账户）跳过并记一条日志，不让一条坏数据挡住其它的。
 */
export function createSecretVault(o: { file: string; cipher: SecretCipher; logger: Logger }): SecretVault {
  const doc = createJsonDocument({
    file: o.file,
    schema: VaultFile,
    defaults: (): VaultFile => ({ version: 1, entries: {} }),
    logger: o.logger,
    debounceMs: 0,
  })
  let loaded: Promise<VaultFile> | undefined
  const current = async (): Promise<VaultFile> => {
    loaded ??= doc.load()
    await loaded
    return doc.current()
  }

  return {
    async lease(namespace) {
      const stored = (await current()).entries[namespace] ?? {}
      const out: Record<string, string> = {}
      for (const [key, cipherText] of Object.entries(stored)) {
        try {
          out[key] = o.cipher.decrypt(cipherText)
        } catch (e) {
          /* 只记命名空间与键：值（密文也一样）不进日志 */
          o.logger.warn('secret could not be decrypted, skipped', { namespace, key, error: String(e) })
        }
      }
      return out
    },
    async put(namespace, key, value) {
      if (!o.cipher.available()) {
        throw new AppError(secretsErrors.unavailable, '系统的凭据加密不可用，密钥没有保存')
      }
      const cipherText = o.cipher.encrypt(value)
      const file = await current()
      await doc.save({
        ...file,
        entries: { ...file.entries, [namespace]: { ...file.entries[namespace], [key]: cipherText } },
      })
    },
    async delete(namespace, key) {
      const file = await current()
      const bucket = file.entries[namespace]
      if (bucket === undefined || !(key in bucket)) return
      const { [key]: _removed, ...rest } = bucket
      const entries = { ...file.entries }
      if (Object.keys(rest).length === 0) delete entries[namespace]
      else entries[namespace] = rest
      await doc.save({ ...file, entries })
    },
  }
}
