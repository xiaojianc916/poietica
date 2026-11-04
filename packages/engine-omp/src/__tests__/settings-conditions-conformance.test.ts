import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * agent-settings 的可见性判据是**手抄** omp `config/settings-ui.ts` 的 CONDITIONS：omp 只搬
 * condition 的名字，求值在界面侧（见 packages/engine 的 SettingDescriptor 注释）。omp 升级新增
 * 条件时，界面侧不认识它就会静默隐藏那一格 —— 少显示一格人看得出，但没人知道是漏了。
 *
 * 这里直接读两边源码对名字：新条件必须进 HANDLED 或 IGNORED，删条件也必须同步清理。
 * 只做名字集合的一致性，不验求值语义（那需要 omp 的设置对象与终端环境）。
 */
const repoRoot = path.resolve(import.meta.dir, '../../../..')
const featureFile = path.join(repoRoot, 'features/agent-settings/src/ui/settings-conditions.ts')
const ompEntry = path.dirname(fileURLToPath(import.meta.resolve('@oh-my-pi/pi-coding-agent')))
const ompFile = path.join(ompEntry, 'config/settings-ui.ts')

const HANDLED: Readonly<Record<string, true>> = {
  advisorEnabled: true,
  hindsightActive: true,
  mnemopiActive: true,
  autolearnActive: true,
  autoThinkingActive: true,
  usageAwareFallbackEnabled: true,
  planModeEnabled: true,
  planAutosaveEnabled: true,
  macOS: true,
}

/*
 * 刻意不求值的条件：
 * - hasImageProtocol：问的是终端能否显示图片，这个宿主不是终端，没有答案；
 * - vimModeEnabled：只管 `tui.*`，本仓不展示这些设置；
 * - nativeRendering / contextFilesExtraNotProject / restrictedFoldersNotProject / perCallModelAllowNotProject：
 *   对应设置不在本仓的设置目录里（渲染能力或项目级写入限制由 omp 自己处理）。
 */
const IGNORED: Readonly<Record<string, true>> = {
  hasImageProtocol: true,
  vimModeEnabled: true,
  nativeRendering: true,
  contextFilesExtraNotProject: true,
  restrictedFoldersNotProject: true,
  perCallModelAllowNotProject: true,
}

function keysOf(source: string, declaration: string): Set<string> {
  const start = source.indexOf(declaration)
  if (start < 0) throw new Error(`找不到 ${declaration}`)
  const bodyStart = source.indexOf('{', start)
  const bodyEnd = source.indexOf('\n}', bodyStart)
  if (bodyStart < 0 || bodyEnd < 0) throw new Error(`${declaration} 的形状变了`)
  const body = source.slice(bodyStart + 1, bodyEnd)
  const keys = new Set<string>()
  for (const match of body.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):/gm)) keys.add(match[1] as string)
  return keys
}

describe('agent-settings 与 omp 条件名的一致性', () => {
  const ompConditions = keysOf(readFileSync(ompFile, 'utf8'), 'const CONDITIONS')
  const predicates = keysOf(readFileSync(featureFile, 'utf8'), 'const PREDICATES')

  test('omp 的每个 condition 要么已实现，要么有明确的忽略理由', () => {
    const unclassified = [...ompConditions].filter((name) => HANDLED[name] !== true && IGNORED[name] !== true)
    expect(unclassified).toEqual([])
  })

  test('实现与忽略名单都没有过期条目', () => {
    expect(Object.keys(HANDLED).filter((name) => !ompConditions.has(name))).toEqual([])
    expect(Object.keys(IGNORED).filter((name) => !ompConditions.has(name))).toEqual([])
  })

  test('界面侧 PREDICATES 与 HANDLED 一致', () => {
    expect([...predicates].sort()).toEqual(Object.keys(HANDLED).sort())
  })
})
