/*
 * 设置目录的两条判据，一条都不许松：
 *
 * 1. 目录是**从 omp 的 schema 读出来的**，不是我们抄的 —— 所以它的条数与每一格的出处
 *    必须与上游此刻的自报一致（减去跟这台桌面软件无关的那几格，判据在
 *    settings-labels.ts 的 `irrelevantSettingOf`）。抄一份的代码会在上游加一格时静默落后，
 *    而这一条会红。标题那一列是我们补的中文，由 settings-labels.test.ts 逐格钉住。
 * 2. 钥匙那一格绝不带值。这是隐私边界，写错就是把用户的钥匙送到 webview。
 *
 * 自检跑法：bun test src/__tests__/settings.test.ts
 */

import { expect, test } from 'bun:test'
import {
  getUi,
  hasUi,
  SETTINGS_SCHEMA,
  type SettingPath,
} from '@oh-my-pi/pi-coding-agent/config/settings-schema'
import { readCatalog } from '../settings.ts'
import {
  irrelevantSettingOf,
  memorySettingOf,
  personaSettingOf,
  settingLabelOf,
} from '../settings-labels.ts'

/** 一个假 reader：给什么回什么，用来钉住「目录不读我们的状态」。 */
function reader(values: Record<string, unknown> = {}): { get(key: string): unknown } {
  return { get: (key) => values[key] }
}

test('the catalog is omp own schema, not a copy in our source', () => {
  const all = readCatalog(reader())
  /*
   * 上游自报的带 ui 元数据的那几格，去掉跟这台桌面软件无关的。
   *
   * 「无关」的判据在 settings-labels.ts 的 `irrelevantSettingOf`，由 settings-labels.test.ts
   * 逐格钉住。这里只确认两件事：留下来的每一格都出自上游，且一条不多一条不少。
   */
  const expected = (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).filter(
    (path) => hasUi(path) && !irrelevantSettingOf(path, getUi(path)?.group),
  )

  // 条数必须等于上游自报的那几格减去不上屏的。差一条就说明两边分叉了。
  expect(all.length).toBe(expected.length)
  /* 防空转：这一条与上面那条不同，它挡的是「筛选把整个目录吃光」。 */
  expect(all.length).toBeGreaterThan(250)

  /*
   * 标题仍是「从路径算出来的」，不是这段代码自己编的一句：认不出的路径由
   * settingLabelOf 原文返回上游 label。说明那一列的中文同样由
   * settings-labels.test.ts 逐格钉住（它是我们补的，无法与上游相等）。
   */
  for (const entry of all) {
    const ui = getUi(entry.path as SettingPath)

    if (ui === undefined) {
      throw new Error(`catalog carries ${entry.path}, which has no ui metadata upstream`)
    }

    expect(entry.label).toBe(settingLabelOf(entry.path, ui.label))
  }

  /* 每一格都出自上游那张表：没有一格是我们自己造的。 */
  for (const entry of all) {
    expect(entry.path in SETTINGS_SCHEMA).toBe(true)
  }
})

/*
 * 现算的选项表那一格：schema 里给不出选项（`sharpshooter.model` 只是 string），
 * 选项由桥拿模型目录现填 —— 判据是「谁算得出」，不是「谁想画」。
 *
 * 两条一起钉：调用方交什么就填什么；且**只有**那一格拿到，别的格子不受影响
 * （把选项表糊到所有 string 格子上，会让它们全都变成下拉框）。
 */
test('a setting with no schema options takes the ones the caller computes', () => {
  const choices = [
    { value: '', label: '自动（使用 smol 角色）' },
    { value: 'p/m', label: 'M' },
  ]
  const entries = readCatalog(reader(), (path) =>
    path === 'sharpshooter.model' ? choices : undefined,
  )

  expect(entries.find((entry) => entry.path === 'sharpshooter.model')?.options).toEqual(choices)
  /* 没有判据的格子仍然没有选项表 —— 一格都不许被顺带填上。 */
  expect(entries.find((entry) => entry.path === 'personality')?.options).not.toEqual(choices)
  expect(
    entries.find((entry) => entry.path === 'sharpshooter.intervalMinutes')?.options,
  ).toBeUndefined()
})

test('a credential never carries its value, only whether it is set', () => {
  const secretPath = 'mnemopi.llmApiKey'
  const planted = 'sk-do-not-leak-this-key'

  const entry = readCatalog(reader({ [secretPath]: planted })).find(
    (candidate) => candidate.path === secretPath,
  )

  expect(entry?.secret).toBe(true)
  // 值那一格必须缺席；配过没有由布尔那一格说。
  expect(entry?.value).toBeNull()
  expect(entry?.hasValue).toBe(true)
  // 整份载荷里一个字都不许出现 —— 序列化之后再查一次，防止将来加格时漏掉。
  expect(JSON.stringify(readCatalog(reader({ [secretPath]: planted })))).not.toContain(planted)
})

test('an unset or blank credential reads as not configured, not as configured', () => {
  const secretPath = 'mnemopi.llmApiKey'
  const at = (values: Record<string, unknown>) =>
    readCatalog(reader(values)).find((entry) => entry.path === secretPath)?.hasValue

  expect(at({})).toBe(false)
  expect(at({ [secretPath]: '' })).toBe(false)
  expect(at({ [secretPath]: '   ' })).toBe(false)
  expect(at({ [secretPath]: 'sk-real' })).toBe(true)
})

test('a normal setting carries its current value, and a runtime-option enum carries none', () => {
  const entries = readCatalog(reader({ 'browser.headless': false }))

  const headless = entries.find((entry) => entry.path === 'browser.headless')
  expect(headless?.type).toBe('boolean')
  expect(headless?.value).toBe(false)
  expect(headless?.secret).toBe(false)

  /*
   * `theme.dark` 的选项是 `'runtime'`（要现算），不是一张固定表：那一格如实没有 options，
   * 而不是编一张空表骗界面画一个空下拉。
   */
  const theme = entries.find((entry) => entry.path === 'theme.dark')
  expect(theme?.options).toBeUndefined()
})

/*
 * 归属这一层：产品把「记忆」与「个性化」各拆成一页，主页面不再画这两类行。
 * 判据在 settings-labels.ts，这里是它的消费者契约 —— 界面只读 `entry.section`。
 */

test('every setting on the agent own memory tab belongs to the memory page', () => {
  const entries = readCatalog(reader())
  const tabOf = (path: string) => getUi(path as SettingPath)?.tab

  /*
   * 上游那一栏此刻 30 格（18.3.0 实测）。条数钉住是有意的：归属的判据是 tab，
   * 所以这一栏有几格就有几格归「记忆」，不多不少。
   */
  const memory = entries.filter((entry) => memorySettingOf(tabOf(entry.path) ?? ''))

  expect(memory.length).toBe(30)
  expect(memorySettingOf('memory')).toBe(true)

  for (const entry of memory) {
    expect(entry.section).toBe('memory')
  }

  /* 别的栏一格都不许被划进「记忆」：判据是 tab，不是路径前缀。 */
  for (const entry of entries) {
    if (!memorySettingOf(tabOf(entry.path) ?? '')) {
      expect(entry.section).not.toBe('memory')
    }
  }
})

test('the persona page takes the settings that shape how the model writes', () => {
  const entries = readCatalog(reader())
  const sectionOf = (path: string) => entries.find((entry) => entry.path === path)?.section

  /*
   * 上游没有「个性化」这一栏，这些格子散在 model 栏的 Prompt / Thinking 两个
   * group 里，所以判据只能是 path 名单。
   */
  const persona = [
    'personality',
    'skillful',
    'includeModelInPrompt',
    'includeWorkspaceTree',
    'inlineToolDescriptors',
    'modelRoleStorage',
    'omitThinking',
    'externalThinking',
    'providers.autoThinkingMaxEffort',
    /* 已被输入框那一排的档位选择器管着（owned），但人设归属仍是事实。 */
    'defaultThinkingLevel',
  ]

  for (const path of persona) {
    expect(sectionOf(path)).toBe('persona')
  }

  /* 名单就是全部：一格不多一格不少，`tier.*` 与采样那一组都不在其中。 */
  const actual = entries.filter((entry) => entry.section === 'persona').map((entry) => entry.path)
  expect(actual.sort()).toEqual([...persona].sort())

  /*
   * 采样那一组没有归属：产品不摆这套逐供应商调参的旋钮。它们仍在目录里（值照报，
   * omp 的 sdk.ts 逐个读它们），只是没有任何一页画它们的行。
   */
  for (const path of [
    'temperature',
    'topP',
    'topK',
    'minP',
    'presencePenalty',
    'repetitionPenalty',
    'textVerbosity',
  ]) {
    expect(sectionOf(path)).toBeUndefined()
  }

  /*
   * `defaultThinkingLevel` 是唯一同时命中两个判据的格子：section 与 owned 正交，
   * owned 说的是「这一行别处已经有控件」，section 说的是「这一行归哪一页」。
   */
  const thinkingLevel = entries.find((entry) => entry.path === 'defaultThinkingLevel')
  expect(thinkingLevel?.owned).toBe(true)
  expect(thinkingLevel?.section).toBe('persona')

  expect(entries.filter((entry) => entry.owned && entry.section !== undefined)).toHaveLength(1)

  /*
   * `tier.*` 说的是请求发往哪个服务档位（计费与路由），不是模型怎么写 —— 摆进「个性化」
   * 会让人以为改它能改语气。
   */
  expect(sectionOf('tier.openai')).toBeUndefined()

  /* 同一节里的邻居不会被整节搬走：Sampling 的 `tier.*` 就在名单外。 */
  expect(sectionOf('retry.maxRetries')).toBeUndefined()
})

test('the two sections are mutually exclusive and most settings have none', () => {
  const entries = readCatalog(reader())

  /* 一格至多一个归属：值域只有两个词，断言它落在值域里而不是同时是两件事。 */
  for (const entry of entries) {
    expect([undefined, 'memory', 'persona']).toContain(entry.section)
  }

  const owned = entries.filter((entry) => entry.section !== undefined)
  /*
   * 剥离出来的是 40 格（记忆 30 + 个性化 10，18.3.0 实测）。条数钉住是有意的：
   * 判据一边认 tab、一边认 path，条数变了就说明上游动了这两处结构，值得人看一眼。
   */
  expect(owned.length).toBe(40)
  expect(entries.filter((entry) => entry.section === 'memory')).toHaveLength(30)
  expect(entries.filter((entry) => entry.section === 'persona')).toHaveLength(10)
  /* 绝大多数格子不属于任何剥离页：归属是例外，不是默认。 */
  expect(owned.length).toBeLessThan(entries.length / 2)

  /* 两个判据在全部格子上逐一互斥：memory 的 tab 判据与 persona 的 path 判据不相交。 */
  for (const entry of entries) {
    expect(
      memorySettingOf(getUi(entry.path as SettingPath)?.tab ?? '') && personaSettingOf(entry.path),
    ).toBe(false)
  }
})

/*
 * 选项名那一列的中文。
 *
 * 判据是「`label` 换中文、`value` 一格不动」：写回 agent 的是 `value`，它被译了就等于
 * 把用户选的档写成了另一个 —— 屏幕上看不出哪里错了。所以两条一起钉。
 */
test('an option label is Chinese while its value stays the identifier we write back', () => {
  const entries = readCatalog(reader())
  const backend = entries.find((entry) => entry.path === 'memory.backend')

  const values = (backend?.options ?? []).map((option) => option.value)
  expect(values).toEqual(['off', 'local', 'hindsight', 'mnemopi', 'sharpshooter'])

  /* 上游那几行英文一个都不许留在 label 上（认得出的格子逐档都有译文）。 */
  expect((backend?.options ?? []).map((option) => option.label)).toEqual([
    '关闭',
    '本地摘要流水线',
    'Hindsight 远程记忆',
    'Mnemopi SQLite',
    'Sharpshooter',
  ])

  const personality = entries.find((entry) => entry.path === 'personality')
  expect((personality?.options ?? []).map((option) => option.label)).toEqual([
    '默认',
    '友好',
    '务实',
    '不使用',
  ])
  /* `value` 仍是上游的词：`none` 不许因为译成「不使用」就跟着变。 */
  expect(personality?.options?.map((option) => option.value)).toContain('none')
})

/*
 * 同一个取值在不同格子上是不同的话：只按 value 索引会把两格合成一句。
 * 判例是 `none` —— `personality` 是「不使用」，`mnemopi.llmMode` 也是「不使用」，
 * 而 `auto` 在 `inlineToolDescriptors` 是「自动」。
 */
test('an option translation is keyed by path, not by value alone', () => {
  const entries = readCatalog(reader())
  const labelOf = (path: string, value: string) =>
    entries.find((entry) => entry.path === path)?.options?.find((o) => o.value === value)?.label

  expect(labelOf('mnemopi.llmMode', 'none')).toBe('不使用')
  expect(labelOf('inlineToolDescriptors', 'auto')).toBe('自动')
  /* `none` 在别处也是「不使用」，但这两格的键是 path —— 换一格仍各取各的。 */
  expect(labelOf('hindsight.retainMode', 'last-turn')).toBe('最近一轮')
  expect(labelOf('hindsight.retainMode', 'full-session')).toBe('整段会话')
})

/*
 * 这一层只翻「给人看的那一列」，其余一个字段都不许动 —— 尤其是 `value`。
 * 用一个假 reader 造出与线上同形的输入，逐档比一遍。
 */
test('translating an option label leaves the value, order and count untouched', () => {
  const entries = readCatalog(reader())
  const translated = entries.filter((entry) => entry.options !== undefined)

  /* 防空转：这一批确实有格子。 */
  expect(translated.length).toBeGreaterThan(0)

  for (const entry of translated) {
    const upstream = getUi(entry.path as SettingPath)?.options

    if (!Array.isArray(upstream)) {
      continue
    }

    const mine = entry.options ?? []

    expect(mine.length).toBe(upstream.length)

    for (const [index, option] of mine.entries()) {
      expect(option.value).toBe(upstream[index]?.value)
    }
  }
})
