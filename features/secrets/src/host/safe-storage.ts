import type { SecretCipher } from './vault'

/** Electron safeStorage 里用得着的几格（签名照 electron.d.ts） */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
  /** 只有 Linux 上有：`basic_text` 表示没有钥匙串、只是写明文 */
  getSelectedStorageBackend?(): string
}

/**
 * safeStorage → SecretCipher。Windows 上是 DPAPI（绑当前 Windows 账户）；Linux 上没有钥匙串时 Electron
 * 会退到 `basic_text`（等于明文），那种情况按「不可用」处理。
 */
export function safeStorageCipher(safeStorage: SafeStorageLike): SecretCipher {
  return {
    available: () => safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text',
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (cipherText) => safeStorage.decryptString(Buffer.from(cipherText, 'base64')),
  }
}
