import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createTestLogger, tempDir } from '@poietica/test-kit'
import { safeStorageCipher } from '../safe-storage'
import { createSecretVault, type SecretCipher } from '../vault'

/** 可逆但不是明文的假加密：反转再 base64 —— 足够验证「文件里没有明文」 */
function fakeCipher(o: { available?: boolean; broken?: string } = {}): SecretCipher {
  return {
    available: () => o.available ?? true,
    encrypt: (plain) => Buffer.from([...plain].reverse().join(''), 'utf8').toString('base64'),
    decrypt: (text) => {
      const plain = [...Buffer.from(text, 'base64').toString('utf8')].reverse().join('')
      if (plain === o.broken) throw new Error('decrypt failed')
      return plain
    },
  }
}

describe('凭据库（ADR-008）', () => {
  test('put → lease 取回；文件里只有密文；delete 后不再返回', async () => {
    const dir = await tempDir('vault-')
    const file = path.join(dir.path, 'secrets', 'vault.json')
    const vault = createSecretVault({ file, cipher: fakeCipher(), logger: createTestLogger() })
    await vault.put('model-api-keys', 'openai', 'sk-plain-openai')
    await vault.put('model-api-keys', 'anthropic', 'sk-plain-anthropic')
    await vault.put('omp-settings', 'hindsight.apiToken', 'tok-plain')
    expect(await vault.lease('model-api-keys')).toEqual({ openai: 'sk-plain-openai', anthropic: 'sk-plain-anthropic' })
    expect(readFileSync(file, 'utf8')).not.toContain('plain')

    await vault.delete('model-api-keys', 'openai')
    await vault.delete('model-api-keys', 'never-there')
    expect(await vault.lease('model-api-keys')).toEqual({ anthropic: 'sk-plain-anthropic' })

    /* 重新打开（下一次启动）读得回来 */
    const reopened = createSecretVault({ file, cipher: fakeCipher(), logger: createTestLogger() })
    expect(await reopened.lease('omp-settings')).toEqual({ 'hindsight.apiToken': 'tok-plain' })
    await dir.dispose()
  })

  test('系统加密不可用：put 报 secrets.unavailable，什么都不写（不退回明文）', async () => {
    const dir = await tempDir('vault-')
    const file = path.join(dir.path, 'vault.json')
    const vault = createSecretVault({ file, cipher: fakeCipher({ available: false }), logger: createTestLogger() })
    await expect(vault.put('model-api-keys', 'openai', 'sk-x')).rejects.toMatchObject({ code: 'secrets.unavailable' })
    expect(() => readFileSync(file, 'utf8')).toThrow()
    await dir.dispose()
  })

  test('解不开的条目（换了机器 / 账户）跳过并记日志，不挡其它条目；日志里没有值', async () => {
    const dir = await tempDir('vault-')
    const file = path.join(dir.path, 'vault.json')
    const logger = createTestLogger()
    const writer = createSecretVault({ file, cipher: fakeCipher(), logger })
    await writer.put('model-api-keys', 'good', 'sk-good')
    await writer.put('model-api-keys', 'bad', 'sk-bad')
    const reader = createSecretVault({ file, cipher: fakeCipher({ broken: 'sk-bad' }), logger })
    expect(await reader.lease('model-api-keys')).toEqual({ good: 'sk-good' })
    expect(JSON.stringify(logger.records)).not.toContain('sk-bad')
    await dir.dispose()
  })

  test('safeStorage 适配：Linux 的 basic_text 后端按不可用处理；密文是 base64', () => {
    const fake = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(`enc:${s}`),
      decryptString: (b: Buffer) => b.toString().slice(4),
    }
    const cipher = safeStorageCipher(fake)
    expect(cipher.available()).toBe(true)
    expect(cipher.decrypt(cipher.encrypt('k'))).toBe('k')
    expect(cipher.encrypt('k')).toBe(Buffer.from('enc:k').toString('base64'))
    expect(safeStorageCipher({ ...fake, getSelectedStorageBackend: () => 'basic_text' }).available()).toBe(false)
    expect(safeStorageCipher({ ...fake, isEncryptionAvailable: () => false }).available()).toBe(false)
  })
})
