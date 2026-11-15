import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { createTestLogger, tempDir } from '@poietica/test-kit'
import { safeStorageCipher } from '../safe-storage'
import { createSecretVault, type SecretCipher } from '../vault'

/**
 * ADR-008 的验收口径：「磁盘上搜不到明文凭据」。
 *
 * 这里走**真实**的凭据库（createSecretVault）与真实的 safeStorage 适配层形状，只把系统加密换成
 * 一个可逆但非明文的假密码机 —— 真 DPAPI 绑当前 Windows 账户，测试里造不出第二台机器。
 * 断言的是落盘字节：把整个数据根逐文件读成文本，挨个搜写进去的那几把钥匙。
 */

const SECRETS = ['sk-plain-openai-0123456789', 'sk-plain-anthropic-abcdefgh', 'tok-hindsight-secret-value'] as const

/** 可逆但落盘不是明文：逐字节取反再 base64（与域无关，只用来证明「文件里搜不到原文」） */
function reversibleCipher(): SecretCipher {
  return {
    available: () => true,
    encrypt: (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ 0xff)).toString('base64'),
    decrypt: (text) => Buffer.from(Buffer.from(text, 'base64').map((byte) => byte ^ 0xff)).toString('utf8'),
  }
}

/** 数据根下的每个文件（凭据库不在子目录里就是它自己） */
function filesUnder(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(full)
    }
  }
  walk(root)
  return out
}

function bytesOf(file: string): string {
  const size = statSync(file).size
  return size === 0 ? '' : readFileSync(file).toString('latin1')
}

describe('凭据只读化（ADR-008：磁盘上搜不到明文）', () => {
  test('写进凭据库的钥匙不出现在数据根的任何文件里；取回时仍是原文', async () => {
    const dir = await tempDir('vault-disk-')
    const file = path.join(dir.path, 'secrets', 'vault.json')
    const vault = createSecretVault({ file, cipher: reversibleCipher(), logger: createTestLogger() })

    await vault.put('model-api-keys', 'openai', SECRETS[0])
    await vault.put('model-api-keys', 'anthropic', SECRETS[1])
    await vault.put('omp-settings', 'hindsight.apiToken', SECRETS[2])

    for (const scanned of filesUnder(dir.path)) {
      const text = bytesOf(scanned)
      for (const secret of SECRETS) {
        expect({ file: path.basename(scanned), leaked: text.includes(secret) }).toEqual({
          file: path.basename(scanned),
          leaked: false,
        })
      }
    }

    /* 取回仍是原文：加密换了形状，语义没变 */
    expect(await vault.lease('model-api-keys')).toEqual({ openai: SECRETS[0], anthropic: SECRETS[1] })
    expect(await vault.lease('omp-settings')).toEqual({ 'hindsight.apiToken': SECRETS[2] })
    await dir.dispose()
  })

  test('系统加密不可用时什么都不落盘：数据根里没有密文库，也没有明文', async () => {
    const dir = await tempDir('vault-disk-')
    const file = path.join(dir.path, 'secrets', 'vault.json')
    const cipher = { ...reversibleCipher(), available: () => false }
    const vault = createSecretVault({ file, cipher, logger: createTestLogger() })

    await expect(vault.put('model-api-keys', 'openai', SECRETS[0])).rejects.toMatchObject({
      code: 'secrets.unavailable',
    })
    /* 连目录都不该建：失败不留下一个空壳，别人也就不会以为凭据存过了 */
    for (const scanned of filesUnder(dir.path)) {
      expect(bytesOf(scanned).includes(SECRETS[0])).toBe(false)
    }
    await dir.dispose()
  })

  test('safeStorage 适配层：Windows 的 DPAPI 是可用路径；Linux basic_text 按不可用（不退回明文）', () => {
    const windows = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(`dpapi:${s}`),
      decryptString: (b: Buffer) => b.toString().slice(6),
    }
    expect(safeStorageCipher(windows).available()).toBe(true)
    expect(safeStorageCipher(windows).decrypt(safeStorageCipher(windows).encrypt('sk-1'))).toBe('sk-1')
    expect(safeStorageCipher({ ...windows, isEncryptionAvailable: () => false }).available()).toBe(false)
    expect(safeStorageCipher({ ...windows, getSelectedStorageBackend: () => 'basic_text' }).available()).toBe(false)
  })
})
