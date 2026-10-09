import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { noopLogger } from '@poietica/foundation'
import { CustomProvidersFile, modelsFilePath } from '../models-file'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'poietica-models-file-'))
  made.push(dir)
  return dir
}

describe('models.yml 的读改写', () => {
  test('整份读整份写：用户手写的其它字段原样保留', async () => {
    const dir = tempDir()
    const file = modelsFilePath(dir)
    writeFileSync(
      file,
      [
        'providers:',
        '  hand-written:',
        '    baseUrl: https://example.test/v1',
        '    auth: none',
        'modelOverrides:',
        '  something: true',
        '',
      ].join('\n'),
      'utf8',
    )
    const port = new CustomProvidersFile({ file, logger: noopLogger, reload: () => undefined })
    await port.upsert({
      id: 'mine',
      name: 'Mine',
      api: 'openai-completions',
      baseUrl: 'https://mine.test/v1',
      models: [{ id: 'm1', name: 'M1', contextWindow: 8000, reasoning: true, vision: true }],
    })
    const raw = readFileSync(file, 'utf8')
    const parsed = Bun.YAML.parse(raw) as Record<string, unknown>
    const providers = parsed.providers as Record<string, Record<string, unknown>>
    expect(Object.keys(parsed)).toContain('modelOverrides')
    expect(providers['hand-written']).toEqual({ baseUrl: 'https://example.test/v1', auth: 'none' })
    expect(providers.mine?.api).toBe('openai-completions')
    expect(providers.mine?.auth).toBe('none')
    const models = providers.mine?.models as Record<string, unknown>[]
    expect(models[0]?.id).toBe('m1')
    expect(models[0]?.input).toEqual(['text', 'image'])
  })

  test('写完让 registry 重新读取（reload 回调）', async () => {
    const dir = tempDir()
    const file = modelsFilePath(dir)
    let reloads = 0
    const port = new CustomProvidersFile({
      file,
      logger: noopLogger,
      reload: () => {
        reloads += 1
      },
    })
    await port.upsert({ id: 'a', name: 'A', api: 'openai-responses', baseUrl: 'https://a.test', models: [] })
    expect(reloads).toBe(1)
    await port.remove('a')
    expect(reloads).toBe(2)
    /* 删不存在的定义不算失败，也不重复落盘 */
    await port.remove('a')
    expect(reloads).toBe(2)
  })

  test('认不出的内容如实报错，不拿空配置覆盖', async () => {
    const dir = tempDir()
    const file = modelsFilePath(dir)
    writeFileSync(file, '- 这不是映射\n', 'utf8')
    const port = new CustomProvidersFile({ file, logger: noopLogger, reload: () => undefined })
    await expect(port.remove('x')).rejects.toThrow(/不是一份 YAML 映射/)
    expect(readFileSync(file, 'utf8')).toBe('- 这不是映射\n')
  })

  test('defined 认得出 models.yml 里的 provider', async () => {
    const dir = tempDir()
    const file = modelsFilePath(dir)
    const port = new CustomProvidersFile({ file, logger: noopLogger, reload: () => undefined })
    expect(await port.defined('nope')).toBe(false)
    await port.upsert({ id: 'nope', name: 'N', api: 'anthropic-messages', baseUrl: 'https://n.test', models: [] })
    expect(await port.defined('nope')).toBe(true)
  })
})
