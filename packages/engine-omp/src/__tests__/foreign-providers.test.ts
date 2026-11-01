import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FOREIGN_PROVIDERS } from '../foreign-providers'

/*
 * 隔离的完整性闸门：omp 的 discovery provider 是一组会读「用户机器上别的工具目录」的插件。
 * FOREIGN_PROVIDERS 是手抄的禁用名单 —— omp 升级新增一个 provider 时，名单不会自己跟上，
 * 而所有闸门仍会绿，数据已经出了隔离根。这里直接读随包 omp 的 `src/discovery/*.ts`，
 * 把「omp 实际有哪些 provider」与「我们禁用/放行了哪些」对起来；新 id 出现就红。
 *
 * 允许名单只收不读外来目录的 provider：
 * - native / omp-plugins / mcp-json / ssh-json：omp 自己的配置与传输；
 * - agents：产品决定放行 `.agent` / `.agents`；
 * - skillshare：共享技能目录；
 * - custom-context：只读用户在设置里显式列出的文件名，不是固定的外来工具目录。
 */
const ALLOWED: Readonly<Record<string, true>> = {
  native: true,
  'omp-plugins': true,
  'mcp-json': true,
  'ssh-json': true,
  agents: true,
  skillshare: true,
  'custom-context': true,
}

const discoveryDir = path.join(
  path.dirname(fileURLToPath(import.meta.resolve('@oh-my-pi/pi-coding-agent'))),
  'discovery',
)

function providerIds(): Set<string> {
  const ids = new Set<string>()
  for (const file of readdirSync(discoveryDir)) {
    if (!file.endsWith('.ts')) continue
    const source = readFileSync(path.join(discoveryDir, file), 'utf8')
    for (const match of source.matchAll(/const PROVIDER_ID = ["']([^"']+)["']/g)) ids.add(match[1] as string)
  }
  return ids
}

describe('omp discovery provider 的隔离名单', () => {
  test('随包 omp 的每个 discovery provider 都被归入禁用或显式放行', () => {
    const ids = providerIds()
    /* 解析到空目录时不要静默通过：说明扫描方式已经跟不上 omp 的打包形状 */
    expect(ids.size).toBeGreaterThanOrEqual(15)
    const unclassified = [...ids].filter((id) => !FOREIGN_PROVIDERS.includes(id) && ALLOWED[id] !== true)
    expect(unclassified).toEqual([])
  })

  test('禁用名单没有过期条目', () => {
    const ids = providerIds()
    expect(FOREIGN_PROVIDERS.filter((id) => !ids.has(id))).toEqual([])
  })

  test('禁用与放行不重叠', () => {
    expect(FOREIGN_PROVIDERS.filter((id) => ALLOWED[id] === true)).toEqual([])
  })
})
