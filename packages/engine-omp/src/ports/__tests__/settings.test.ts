import '../../__tests__/omp-home'

import { describe, expect, test } from 'bun:test'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import { noopLogger } from '@poietica/foundation'
import { isCredentialSetting } from '../../settings-access'
import { OmpSettingsPort } from '../settings'

function makePort(): { port: OmpSettingsPort; settings: Settings } {
  const settings = Settings.isolated()
  return { port: new OmpSettingsPort({ root: settings, logger: noopLogger }), settings }
}

/**
 * global 层是**按点分路径嵌套**的对象（`compaction.enabled` → `{ compaction: { enabled } }`），
 * 不是平铺的键。判「写进去了没有」只能沿路径走。
 */
function globalAt(settings: Settings, path: string): unknown {
  let current: unknown = settings.getGlobalSettings()
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

describe('SettingsPort', () => {
  test('catalog 只列产品开放的键，标签与分组取中文', async () => {
    const { port } = makePort()
    const catalog = await port.catalog()
    expect(catalog.length).toBeGreaterThan(10)
    const paths = catalog.map((entry) => entry.path)
    /* 开放的格子在里面 */
    expect(paths).toContain('compaction.enabled')
    expect(paths).toContain('python.interpreter')
    /* 终端渲染 / array|record 都不在里面 */
    expect(paths).not.toContain('tui.tight')
    expect(paths).not.toContain('enabledModels')
    const compaction = catalog.find((entry) => entry.path === 'compaction.enabled')
    /*
     * `group` 是 omp 自己的分节**键**（界面按它归并），`groupLabel` 才是给人看的那一列。
     * 把译名当键会让两条不同的键撞上同一个名字，而屏幕上看不出哪里错了。
     */
    expect(compaction).toMatchObject({
      group: 'Compaction',
      groupLabel: '上下文压缩',
      label: '自动压缩',
      type: 'boolean',
      owned: false,
      section: null,
    })
    expect(typeof compaction?.description).toBe('string')
    expect(compaction?.description.length).toBeGreaterThan(0)
  })

  /*
   * 产品已有专属控件的格子**留在目录里**，标成 `owned`：值照报，行不画。
   *
   * 判据是「值还有没有别人要读」——`plan.enabled` 是 `planAutosaveEnabled` 的判据。
   * 从目录里抽掉它，那条 condition 会永远为假，而屏幕上没有任何迹象说明为什么。
   */
  test('owned 的格子留在目录里（值照报，行由别处的控件负责）', async () => {
    const { port } = makePort()
    const catalog = await port.catalog()
    const byPath = new Map(catalog.map((entry) => [entry.path, entry]))
    for (const path of ['tools.approvalMode', 'plan.enabled', 'defaultThinkingLevel', 'browser.headless']) {
      expect(byPath.has(path)).toBe(true)
      expect(byPath.get(path)?.owned).toBe(true)
    }
    expect(byPath.get('compaction.enabled')?.owned).toBe(false)
  })

  /*
   * 归属那一层：记忆按 omp 自己的 tab 判（30 格），个性化按 path 名单判（10 格）。
   * 条数钉住是有意的：两边条数变了就说明上游动了这两处结构，值得人看一眼。
   */
  test('记忆 30 格、个性化 10 格，两页的判据互斥', async () => {
    const { port } = makePort()
    const catalog = await port.catalog()
    const memory = catalog.filter((entry) => entry.section === 'memory')
    const persona = catalog.filter((entry) => entry.section === 'persona')
    expect(memory).toHaveLength(30)
    expect(persona).toHaveLength(10)
    /* 归属是例外，不是默认：绝大多数格子不属于任何剥离页。 */
    expect(memory.length + persona.length).toBeLessThan(catalog.length / 2)
    /* 记忆那一栏的每一格都归记忆。 */
    expect(memory.map((entry) => entry.path)).toContain('memory.backend')
    expect(memory.map((entry) => entry.path)).toContain('mnemopi.bank')
    expect(persona.map((entry) => entry.path)).toContain('personality')
    /* `defaultThinkingLevel` 两个判据都命中：section 与 owned 正交。 */
    const thinking = catalog.find((entry) => entry.path === 'defaultThinkingLevel')
    expect(thinking?.section).toBe('persona')
    expect(thinking?.owned).toBe(true)
  })

  /*
   * 条件与选项都从 omp 读：条件是**名字**（求值在界面那一侧，判据要用此刻的值），
   * 选项是一张 `{value,label}` 表（value 写回 agent，label 上屏）。
   */
  test('condition 与 options 原样带出来', async () => {
    const { port } = makePort()
    const catalog = await port.catalog()
    const byPath = new Map(catalog.map((entry) => [entry.path, entry]))
    expect(byPath.get('mnemopi.bank')?.condition).toBe('mnemopiActive')
    expect(byPath.get('hindsight.apiUrl')?.condition).toBe('hindsightActive')
    expect(byPath.get('memory.backend')?.condition).toBeNull()

    const backend = byPath.get('memory.backend')
    expect(backend?.options).not.toBeNull()
    /* value 一格不译（写回 agent 的就是它），label 取中文。 */
    expect(backend?.options?.find((option) => option.value === 'hindsight')?.label).toBe('Hindsight 远程记忆')
    /* 认不出的 path 原样交回上游 label。 */
    const personality = byPath.get('personality')
    expect(personality?.options?.find((option) => option.value === 'none')?.label).toBe('不使用')
  })

  test('catalog 的每一条都过 zod（SettingDescriptor）', async () => {
    const { port } = makePort()
    const { SettingDescriptor } = await import('@poietica/engine')
    for (const entry of await port.catalog()) {
      expect(SettingDescriptor.safeParse(entry).success).toBe(true)
    }
  })

  test('凭据类设置的 value 一律 null，默认值照报', async () => {
    const { port, settings } = makePort()
    const handle = (await import('@oh-my-pi/pi-coding-agent/config/registry')).lookup('hindsight.apiToken')
    expect(isCredentialSetting('hindsight.apiToken')).toBe(true)
    handle?.set(settings, 'token-should-not-leak' as never)
    const entry = (await port.catalog()).find((row) => row.path === 'hindsight.apiToken')
    expect(entry?.value).toBeNull()
    expect(JSON.stringify(entry)).not.toContain('token-should-not-leak')
    /* 默认值不是凭据，照报 */
    expect(entry?.defaultValue).toBeNull()
  })

  /*
   * 现算的选项表：`sharpshooter.model` 的取值是「模型目录里的某一条」，而上游 schema 只给了
   * string —— 选项必须由端口用**模型目录**现填（legacy 的 `SettingChoicesOf` 同此）。
   *
   * 少了这一格，界面上就是一个自由输入框，而这一格填的值必须是目录里的 `provider/id`：
   * 拼法不同就选不中，模型解析静默回落 smol。
   */
  test('sharpshooter.model 用模型目录现算选项，含「自动」空串档', async () => {
    const settings = Settings.isolated()
    const port = new OmpSettingsPort({
      root: settings,
      logger: noopLogger,
      registry: {
        all: () => [],
        available: () => [
          { provider: 'anthropic', id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
          { provider: 'openai', id: 'gpt-5', name: 'GPT-5' },
        ],
        find: () => undefined,
        hasConfiguredAuth: () => true,
        hydrateCredentialScopedModelCaches: async () => undefined,
        refreshInBackground: () => undefined,
      },
    })
    const entry = (await port.catalog()).find((row) => row.path === 'sharpshooter.model')
    expect(entry?.options).toEqual([
      /* 「自动」那一档的值是**空串**，不是 null：留空 = 用 smol 角色，那是 omp 自己的「没配」表示。 */
      { value: '', label: '自动（使用 smol 角色）', description: null },
      { value: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4', description: null },
      { value: 'openai/gpt-5', label: 'GPT-5', description: null },
    ])
  })

  /* 没有模型目录时不编一张假清单：宁可只有「自动」，也不要报一个选不中的值。 */
  test('没有模型目录时 sharpshooter.model 没有选项（不编假清单）', async () => {
    const { port } = makePort()
    const entry = (await port.catalog()).find((row) => row.path === 'sharpshooter.model')
    expect(entry?.options).toBeNull()
  })

  test('set / reset：不在清单里的路径抛 kernel.invalid_params', async () => {
    const { port } = makePort()
    await expect(port.set('not.a.setting', 1)).rejects.toMatchObject({ code: 'kernel.invalid_params' })
    await expect(port.reset('not.a.setting')).rejects.toMatchObject({ code: 'kernel.invalid_params' })
    await expect(port.set('tui.tight', true)).rejects.toMatchObject({ code: 'kernel.invalid_params' })
  })

  test('set 写进 global 层并 fire，reset 把它删掉（回落默认）', async () => {
    const { port, settings } = makePort()
    const seen: string[][] = []
    const sub = port.onDidChange((value) => {
      seen.push([...value.paths])
    })
    await port.set('compaction.enabled', false)
    expect(globalAt(settings, 'compaction.enabled')).toBe(false)
    await port.reset('compaction.enabled')
    expect(globalAt(settings, 'compaction.enabled')).toBeUndefined()
    expect(seen).toEqual([['compaction.enabled'], ['compaction.enabled']])
    sub.dispose()
  })

  test('capabilities 读 / 写两个能力开关', async () => {
    const { port, settings } = makePort()
    /* browser.enabled 的 schema 默认是 true；computer.enabled 是 false —— 读的就是这两格的默认。 */
    expect(await port.capabilities()).toEqual({ computerUse: false, browserControl: true })
    await port.setCapability('computerUse', true)
    expect(globalAt(settings, 'computer.enabled')).toBe(true)
    expect(await port.capabilities()).toEqual({ computerUse: true, browserControl: true })
  })

  test('setPythonInterpreter：写 python.interpreter，传 null 时 unset', async () => {
    const { port, settings } = makePort()
    await port.setPythonInterpreter('C:\\python\\python.exe')
    expect(globalAt(settings, 'python.interpreter')).toBe('C:\\python\\python.exe')
    // 读回：onReady 的判据要能拿到同一个值（07 页 §13C）
    expect(await port.getPythonInterpreter()).toBe('C:\\python\\python.exe')
    await port.setPythonInterpreter(null)
    expect(globalAt(settings, 'python.interpreter')).toBeUndefined()
    expect(await port.getPythonInterpreter()).toBeNull()
  })
})
