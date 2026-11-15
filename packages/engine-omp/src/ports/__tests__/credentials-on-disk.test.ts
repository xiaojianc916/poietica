import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import { noopLogger } from '@poietica/foundation'
import { CustomProvidersFile, modelsFilePath } from '../models-file'
import { OmpSettingsPort } from '../settings'

/**
 * ADR-008 的验收口径落到引擎这一侧：「磁盘上搜不到明文凭据」。
 *
 * 这里不看代码怎么写的，只看**写完之后磁盘上的字节**：把 omp 的 agent 目录整份读成文本，
 * 挨个搜我们交给它的那几把钥匙。omp 自己管的 OAuth（agent.db）不在这一条的范围里 ——
 * 那是上游的持久化，本轮不搬（见 ADR-008 的「仍未做」）。
 */
const API_KEY = 'sk-engine-side-0123456789abcdef'
const SETTING_SECRET = 'tok-hindsight-9876543210'

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

/** 目录里有没有哪个文件含这串明文（按二进制读，避免编码差异掩盖） */
function leakedInto(root: string, secret: string): string[] {
  return filesUnder(root)
    .filter((file) => readFileSync(file).toString('latin1').includes(secret))
    .map((file) => path.basename(file))
}

/**
 * Settings 句柄里的 SQLite 连接不随测试结束关闭，Windows 上目录会被占住（EBUSY）。
 * 清理是尽力而为：断言已经跑完，留一个临时目录不该让用例变红。
 */
function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* Windows 上 agent.db 还开着；临时目录由系统回收 */
  }
}

describe('引擎配置文件不留明文凭据（ADR-008）', () => {
  test('凭据类设置只进运行时覆盖层：config.yml 里搜不到；非凭据设置照常落盘', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'omp-config-secrets-'))
    try {
      const root = await Settings.loadIsolated({ agentDir: dir })
      const port = new OmpSettingsPort({ root, logger: noopLogger })

      await port.injectSecret('hindsight.apiToken', SETTING_SECRET)
      await port.set('compaction.enabled', false)
      await root.flush()

      /* 非凭据那份确实落盘了：证明这一轮真的写下去了，不是「什么都没写」蒙混过去 */
      expect(readFileSync(path.join(dir, 'config.yml'), 'utf8')).toContain('compaction')
      expect(leakedInto(dir, SETTING_SECRET)).toEqual([])
    } finally {
      cleanup(dir)
    }
  })

  test('自定义服务商写进 models.yml 时不带任何钥匙（auth: none，钥匙走内存）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'omp-models-secrets-'))
    try {
      const file = modelsFilePath(dir)
      const providers = new CustomProvidersFile({ file, logger: noopLogger, reload: () => undefined })
      await providers.upsert({
        id: 'mine',
        name: 'Mine',
        api: 'openai-completions',
        baseUrl: 'https://api.example.test/v1',
        models: [{ id: 'm1', name: 'm1', contextWindow: 8000, reasoning: false, vision: false }],
      })

      const text = readFileSync(file, 'utf8')
      expect(text).toContain('api.example.test')
      /* 「这个文件不提供密钥」是 omp 的 auth: none；钥匙走运行时钥匙层，不写这个文件 */
      expect(text).toContain('auth: none')
      expect(text).not.toContain('apiKey')
      expect(leakedInto(dir, API_KEY)).toEqual([])
    } finally {
      cleanup(dir)
    }
  })
})
