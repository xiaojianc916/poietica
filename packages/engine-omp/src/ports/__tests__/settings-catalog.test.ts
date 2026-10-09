import { describe, expect, test } from 'bun:test'
import {
  descriptionOf,
  GROUP_LABELS,
  groupLabelOf,
  isProductSetting,
  labelOf,
  memorySettingOf,
  optionLabelOf,
  ownedElsewhereOf,
  personaSettingOf,
  sectionOf,
} from '../settings-catalog'

describe('settings-catalog', () => {
  test('开放的键按类型与无关名单过滤', () => {
    expect(isProductSetting('compaction.enabled', 'boolean')).toBe(true)
    expect(isProductSetting('read.defaultLimit', 'number')).toBe(true)
    expect(isProductSetting('secrets.enabled', 'boolean')).toBe(true)
    /* array / record 画不出来，不进目录 */
    expect(isProductSetting('enabledModels', 'array')).toBe(false)
    /* 终端渲染的整族都不摆 */
    expect(isProductSetting('tui.tight', 'boolean')).toBe(false)
    expect(isProductSetting('theme.dark', 'string')).toBe(false)
    expect(isProductSetting('stream.serverUrl', 'string')).toBe(false)
  })

  /*
   * 产品已有专属控件的格子**留在目录里**（`owned`），不在这里挡掉。
   *
   * 判据是「值还有没有别人要读」：`plan.enabled` 是 `planAutosaveEnabled` 的判据、
   * `defaultThinkingLevel` 是 `autoThinkingActive` 的判据。从目录里抽掉它们，
   * 那两条 condition 会**永远为假**，而屏幕上没有任何迹象说明为什么。
   */
  test('产品已有专属控件的格子仍进目录，但标成 owned', () => {
    expect(isProductSetting('plan.enabled', 'boolean')).toBe(true)
    expect(ownedElsewhereOf('plan.enabled')).toBe(true)
    expect(isProductSetting('defaultThinkingLevel', 'enum')).toBe(true)
    expect(ownedElsewhereOf('defaultThinkingLevel')).toBe(true)
    expect(isProductSetting('browser.headless', 'boolean')).toBe(true)
    expect(ownedElsewhereOf('browser.headless')).toBe(true)
    /* 没被别处认领的格子照常不算 owned。 */
    expect(ownedElsewhereOf('compaction.enabled')).toBe(false)
  })

  /*
   * 与这台桌面软件有关、且没有专属控件的格子照常上屏 ——
   * 这几格迁移时曾被前缀判据误删（`advisor.` / `autolearn.` / `ttsr.` / `snapcompact.`），
   * 而它们在 omp 那条边车进程里是真的会生效的。
   */
  test('曾经被前缀误删的格子回到目录里', () => {
    expect(isProductSetting('autolearn.enabled', 'boolean')).toBe(true)
    expect(isProductSetting('advisor.enabled', 'boolean')).toBe(true)
    expect(isProductSetting('ttsr.enabled', 'boolean')).toBe(true)
    expect(isProductSetting('plan.autosave', 'boolean')).toBe(true)
    /* `display.collapseCompacted` 自己走那条读取路径，刻意保留。 */
    expect(isProductSetting('display.collapseCompacted', 'boolean')).toBe(true)
    /* 但 `plan.defaultOnStartup` 是终端会话的节奏，照删。 */
    expect(isProductSetting('plan.defaultOnStartup', 'boolean')).toBe(false)
  })

  test('中文标签与说明查不到就回退英文，绝不返回空串', () => {
    expect(labelOf('compaction.enabled', 'Auto-Compact')).toBe('自动压缩')
    expect(labelOf('nope.nope', 'Auto-Compact')).toBe('Auto-Compact')
    expect(descriptionOf('compaction.enabled', 'fallback')).not.toBe('fallback')
    expect(descriptionOf('nope.nope', 'Fallback text')).toBe('Fallback text')
  })

  test('分节中文名：产品名与协议名刻意不译', () => {
    expect(groupLabelOf('Compaction')).toBe('上下文压缩')
    expect(groupLabelOf('LSP')).toBe('LSP')
    expect(groupLabelOf('Mnemopi')).toBe('Mnemopi')
    expect(groupLabelOf('Nope')).toBe('Nope')
  })

  /* 选项名按 path 再 value 两层索引：同一个取值在不同格子上说的是不同的话。 */
  test('选项中文名按 path 与 value 两层查，查不到回退上游 label', () => {
    expect(optionLabelOf('memory.backend', 'hindsight', 'Hindsight')).toBe('Hindsight 远程记忆')
    expect(optionLabelOf('personality', 'none', 'None')).toBe('不使用')
    /* 同一格的不同取值各有各的说法，互不串门。 */
    expect(optionLabelOf('mnemopi.llmMode', 'none', 'None')).toBe('不使用')
    expect(optionLabelOf('memory.backend', 'none', 'None')).toBe('None')
    /* 认不出的 path 原样交回。 */
    expect(optionLabelOf('nope.nope', 'x', 'Fallback')).toBe('Fallback')
  })
})

/*
 * 归属那一层：产品把「记忆」与「个性化」各拆成一页，两页各取自己那一段。
 *
 * 判据有两套来源，**不能互相替代**：
 *   - 记忆按 omp 自己的 **tab**（它自报的结构，照搬；手抄一份名单就是第二个事实）；
 *   - 个性化按 **path 名单**（上游没有这一栏，「个性化」是产品的切面）。
 */
describe('剥离页的归属', () => {
  test('记忆按 omp 的 tab 判', () => {
    expect(memorySettingOf('memory')).toBe(true)
    expect(memorySettingOf('model')).toBe(false)
    expect(memorySettingOf('')).toBe(false)
  })

  test('个性化按 path 名单判，名单外的一格都不是', () => {
    for (const path of [
      'personality',
      'skillful',
      'includeModelInPrompt',
      'includeWorkspaceTree',
      'inlineToolDescriptors',
      'modelRoleStorage',
      'omitThinking',
      'externalThinking',
      'providers.autoThinkingMaxEffort',
      'defaultThinkingLevel',
    ]) {
      expect(personaSettingOf(path)).toBe(true)
    }
    /* 采样那一组是逐供应商调参旋钮，产品不摆这个界面；`tier.*` 说的是计费与路由。 */
    expect(personaSettingOf('temperature')).toBe(false)
    expect(personaSettingOf('tier.openai')).toBe(false)
    expect(personaSettingOf('retry.maxRetries')).toBe(false)
  })

  test('sectionOf：记忆优先，两者互斥，其余为 null', () => {
    expect(sectionOf('memory.backend', 'memory')).toBe('memory')
    expect(sectionOf('mnemopi.bank', 'memory')).toBe('memory')
    expect(sectionOf('personality', 'model')).toBe('persona')
    expect(sectionOf('defaultThinkingLevel', 'model')).toBe('persona')
    expect(sectionOf('temperature', 'model')).toBeNull()
    expect(sectionOf('compaction.enabled', 'context')).toBeNull()
  })

  /*
   * 两个判据不相交：记忆那一栏的格子不会被 path 名单再认领一次，
   * 否则同一格会被两页同时画出来（一个事实两个控件）。
   */
  test('记忆栏里的格子不会同时命中个性化名单', () => {
    for (const path of ['personality', 'skillful', 'defaultThinkingLevel']) {
      expect(sectionOf(path, 'memory')).toBe('memory')
    }
  })

  test('分节中文名表覆盖 omp 的每一栏（缺一条只是显示英文，不是缺陷）', () => {
    expect(Object.keys(GROUP_LABELS).length).toBeGreaterThan(20)
    for (const [key, value] of Object.entries(GROUP_LABELS)) {
      expect(value.length).toBeGreaterThan(0)
      expect(key.length).toBeGreaterThan(0)
    }
  })
})
