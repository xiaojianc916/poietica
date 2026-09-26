/*
 * 中文文案的两条判据，一条都不许松：
 *
 * 1. **378 格一格都不许静默落回英文。** 逐格走 omp 此刻的 schema（不比条数，逐条查），
 *    少一条就说明我们那张表的键打错了字 —— 而打错字的症状与「上游新加了设置」一模一样，
 *    屏幕上都是英文。只有这条判据能把两者分开。
 * 2. **查不到就原文返回**，且永不返回空。这是这一层的安全属性：表跟不上 omp 时，
 *    页面显示英文而不是把这一格藏起来或显示空白。
 *
 * 自检跑法：bun test src/__tests__/settings-labels.test.ts
 */

import { expect, test } from 'bun:test'
import {
  getPathsForTab,
  getUi,
  hasUi,
  type SettingPath,
} from '@oh-my-pi/pi-coding-agent/config/settings-schema'
import { readCatalog, SETTING_TABS } from '../settings.ts'
import { settingDescriptionOf } from '../settings-descriptions.ts'
import {
  groupLabelOf,
  hasSettingTranslation,
  irrelevantSettingOf,
  settingLabelOf,
  settingLabelSource,
  tabLabelOf,
} from '../settings-labels.ts'

/* `SettingTab` 没从这个入口转出（它在 pi-tui 里，而那不是我们的依赖），按函数的入参取。 */
type Tab = Parameters<typeof getPathsForTab>[0]

/** 上屏那一批格子：omp 自报带 ui 元数据的。与 settings.test.ts 同一份判据。 */
function uiPaths(): SettingPath[] {
  const paths: SettingPath[] = []
  const seen = new Set<string>()

  for (const tab of SETTING_TABS) {
    for (const path of getPathsForTab(tab as Tab) ?? []) {
      if (!hasUi(path) || seen.has(path)) {
        continue
      }

      seen.add(path)
      paths.push(path)
    }
  }

  return paths
}

test('every setting omp puts on screen resolves to Chinese, not to the English fallback', () => {
  const paths = uiPaths()

  expect(paths.length).toBe(378)

  /*
   * 只查真正会上屏的那些：跟这台桌面软件无关的 68 格由桥挡在目录外
   * （settings.ts 的 irrelevantSettingOf），它们的译名不必维护。
   */
  const shown = paths.filter((path) => !irrelevantSettingOf(path, getUi(path)?.group))

  expect(shown.length).toBe(312)

  const untranslated = shown.filter((path) => !hasSettingTranslation(path))

  /* 报出具体是哪些格：只报条数的话，修的时候还得自己再找一遍。 */
  expect(untranslated.map((path) => `${path} :: ${getUi(path)?.label ?? ''}`)).toEqual([])
})

test('a path we do not know falls back to the original English, never to a blank', () => {
  expect(settingLabelOf('no.such.setting', 'Original English')).toBe('Original English')
  expect(groupLabelOf('No Such Group')).toBe('No Such Group')
  expect(tabLabelOf('no-such-tab')).toBe('no-such-tab')

  /* 空串是「没有文案」而不是「查不到」：上游真给空串时我们照它，不编一个。 */
  expect(settingLabelOf('no.such.setting', '')).toBe('')

  /* 英文原文现从 agent 自己的 schema 读，认不出的路径交回空串（界面据此不画）。 */
  expect(settingLabelSource('theme.dark')).toBe('Dark Theme')
  expect(settingLabelSource('no.such.setting')).toBe('')
})

/*
 * 有意不译的分节名：它们是产品名或协议名（§AGENTS 的产品词表），译了反而认不出。
 * 写死在测试里而不是从表里算出来 —— 从表里算就等于没判据：一个没译的英文节
 * 与「刻意不译」在表里长得一模一样，只有这一份名单能把两者分开。
 */
const UNTRANSLATED_GROUPS: readonly string[] = [
  'Bash',
  'Fireworks',
  'Git',
  'GitHub',
  'Hindsight',
  'LSP',
  'Mnemopi',
  'Prewalk',
  'Sharpshooter',
]

test('every tab and every group omp reports carries a Chinese name', () => {
  const groups = new Set<string>()

  for (const tab of SETTING_TABS) {
    expect(tabLabelOf(tab)).not.toBe(tab)
  }

  for (const path of uiPaths()) {
    const group = getUi(path)?.group

    if (group !== undefined) {
      groups.add(group)
    }
  }

  expect(groups.size).toBe(58)

  /* 只有那份产品名名单可以保持英文原文；多一条就说明上游加了节而没人管它。 */
  const untranslated = [...groups].filter((group) => groupLabelOf(group) === group).sort()

  expect(untranslated).toEqual([...UNTRANSLATED_GROUPS].sort())
})

test('the catalog translates the copy but keeps omp identifiers for tab and group', () => {
  /*
   * 换掉的只有给人看的那两列（`label` / `description`）。`tab` / `group` / `path` 是界面
   * 联表与分组的键（agent-settings.tsx 的 `entry.tab === current`、按 `entry.group` 建
   * Map）：换成中文就把两栏两节合成一格，而屏幕上看不出哪里错了。
   *
   * 说明那一列由 settings-descriptions.test.ts 逐格钉住（中文是我们补的，无法与上游相等）。
   */
  const entries = readCatalog({ get: () => undefined })

  for (const entry of entries) {
    const ui = getUi(entry.path as SettingPath)

    expect(entry.label).toBe(settingLabelOf(entry.path, ui?.label ?? ''))
    expect(entry.tab).toBe(ui?.tab ?? '')
    expect(entry.group).toBe(ui?.group)
    expect(entry.description).toBe(settingDescriptionOf(entry.path, ui?.description ?? ''))
  }

  /* 三列里至少有一格确实换成了中文，否则这个测试在空转。 */
  expect(entries.some((entry) => /[\u4e00-\u9fff]/u.test(entry.description))).toBe(true)
})

test('settings that cannot affect this desktop app are left out of the catalog entirely', () => {
  const entries = readCatalog({ get: () => undefined })
  const paths = new Set(entries.map((entry) => entry.path))

  /*
   * 判据不是「折叠起来」，是**不上屏**：画一格改了没效果的控件就是骗人。
   * 实测 66 格：终端渲染与配色、终端键盘补全、终端语音、agent 自己的启动与自更新。
   */
  expect(entries.length).toBe(312)

  for (const gone of [
    'theme.dark',
    'theme.light',
    'tui.mouse',
    'statusLine.preset',
    'composer.shape',
    'symbolPreset',
    'startup.setupWizard',
    'update.channel',
    'spelling.typoDetection',
    'stt.enabled',
    'hideThinkingBlock',
  ]) {
    expect(paths.has(gone)).toBe(false)
  }

  /*
   * 同一栏里真正作用在桌面这层的必须留着 —— `display.showTokenUsage`、`images.blockImages`
   * 与 `display.collapseCompacted` 都改变本界面的画法或行为，删掉就是把能力砍掉。
   */
  for (const kept of [
    'display.showTokenUsage',
    'display.showTurnTime',
    'display.hideToolActivity',
    'images.blockImages',
    'images.autoResize',
    'display.collapseCompacted',
    'colorBlindMode',
  ]) {
    expect(paths.has(kept)).toBe(true)
  }

  expect(irrelevantSettingOf('lsp.enabled', 'LSP')).toBe(false)
  expect(irrelevantSettingOf('theme.dark', 'Theme')).toBe(true)

  /*
   * 判据只认路径，不认分节。
   *
   * `colorBlindMode` 就在 `Theme` 这一节里，而它改的是 diff 的配色 —— 那是我们自己
   * 也画的 diff。拿分节当判据会连它一起删掉：这是实测踩过的坑，钉在这里。
   */
  expect(irrelevantSettingOf('colorBlindMode', 'Theme')).toBe(false)
  expect(irrelevantSettingOf('something.new', 'Status Line')).toBe(false)
})

/*
 * 产品已经有专属控件的那几格，**值照报、行标着不画**。
 *
 * 一个事实两个控件是缺陷（AGENTS.md §1）：输入框那一排已有「计划 / 直接执行」的选择器，
 * 设置页已有「电脑控制」一节 —— agent 设置里再摆一个同名开关，人会看到两个控件说同一件
 * 事，改一个另一个不同步，而且没有任何迹象说明哪个算数。
 *
 * 但值不能抽掉：`plan.autosave` 要 `plan.enabled` 为真才显示、
 * `providers.autoThinkingMaxEffort` 要 `defaultThinkingLevel` 是 auto —— 判据读的就是这一格
 * 的 value。抽掉值，那两行会永远不显示而没有迹象。所以判据是「行标着 owned」+「值仍在」。
 */
test('settings the product already controls elsewhere keep their value but lose their row', () => {
  const byPath = new Map(readCatalog({ get: () => undefined }).map((entry) => [entry.path, entry]))

  for (const path of [
    'plan.enabled',
    'goal.enabled',
    'defaultThinkingLevel',
    'tools.approvalMode',
    'browser.enabled',
    'browser.headless',
    'browser.cdpUrl',
  ]) {
    /* 行还在目录里（值要留给条件），但标着 owned，界面据此不画。 */
    expect([path, byPath.get(path)?.owned]).toEqual([path, true])
  }

  /* 依赖它们的那些格子必须在，否则条件永远为假、那几行静默消失。 */
  for (const dependent of [
    'plan.autosave',
    'plan.autosaveDir',
    'providers.autoThinkingMaxEffort',
  ]) {
    expect([dependent, byPath.has(dependent)]).toEqual([dependent, true])
  }

  expect(byPath.get('plan.enabled')?.value).toBeDefined()
  expect(byPath.get('defaultThinkingLevel')?.value).toBeDefined()

  /* 没有别处入口的邻居不能被顺手删掉。 */
  for (const kept of [
    'plan.autosave',
    'goal.continuationModes',
    'advisor.enabled',
    'browser.relay',
  ]) {
    expect([kept, byPath.get(kept)?.owned]).toEqual([kept, undefined])
  }
})

/*
 * 条件判据引用的那一格，必须还在目录里。
 *
 * 界面的 `settings-conditions.ts` 靠 `condition` 的名字去读某一格的值；被读的那一格一旦
 * 被挡在目录外，这条判据就永远为假 —— 它引用的那一行也跟着永远不显示，而屏幕上没有任何
 * 迹象说明为什么。实测踩过：`vimModeEnabled` 读 `tui.vimMode`，而 `tui.*` 整片已被移出。
 *
 * 判据不硬编码条件表（那是界面那一侧的文件，桥不认识），只查这一件事实：
 * **被引用的设置键本身还在不在目录里**。
 */
test('every setting a condition reads is still in the catalog', () => {
  const paths = new Set(readCatalog({ get: () => undefined }).map((entry) => entry.path))
  const referenced = new Set<string>()
  const dangling: string[] = []

  for (const path of uiPaths()) {
    const condition = getUi(path)?.condition

    if (condition === undefined) {
      continue
    }

    referenced.add(condition)
  }

  /*
   * 界面那侧能求值的条件名与它读的键是同一张表的两半；这里按名字反查它读哪一格。
   * 只在**名字仍在用**时才有意义：没人引用的条件名留着也不显示，不算缺陷。
   */
  const READS: Readonly<Record<string, string>> = {
    advisorEnabled: 'advisor.enabled',
    hindsightActive: 'memory.backend',
    mnemopiActive: 'memory.backend',
    autolearnActive: 'autolearn.enabled',
    autoThinkingActive: 'defaultThinkingLevel',
    usageAwareFallbackEnabled: 'retry.usageAwareFallback',
    planModeEnabled: 'plan.enabled',
    planAutosaveEnabled: 'plan.autosave',
  }

  for (const [condition, read] of Object.entries(READS)) {
    if (referenced.has(condition) && !paths.has(read)) {
      dangling.push(`${condition} -> ${read}`)
    }
  }

  /* 报出具体的名字：只说条数，修的时候还得自己再找一遍。 */
  expect(dangling).toEqual([])

  /* 而且这些条件名本身也该还有人用，否则那张表在空转。 */
  expect([...Object.keys(READS)].some((name) => referenced.has(name))).toBe(true)
})
