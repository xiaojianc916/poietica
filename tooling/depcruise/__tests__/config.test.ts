import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cruise, type IConfiguration, type ICruiseResult } from 'dependency-cruiser'

/*
 * depcruise 配置的**自检**。
 *
 * 背景（真实故障）：`exclude` 与 `doNotFollow` 的分工写错会让规则**静默失效** ——
 * 早先把 `dist` 放进 `exclude`，而 `@oh-my-pi/*` 的 types 指向它自己的 `dist/types/`，
 * 于是 `omp-confined`（「只有 engine-omp 可以 import @oh-my-pi/*」这条铁律）永远不触发，
 * 全仓 0 条 @oh-my-pi 边，`bun run  all` 照样全绿。
 *
 * 这条用例把那个类别钉死：`exclude` 只能收我们自己的产物，外部包必须走 `doNotFollow`
 * （只声明不往里走，节点本身仍在图里，针对它的规则照常判定）。
 */
const CONFIG = path.resolve(import.meta.dir, '../config.cjs')

interface Options {
  readonly exclude?: { readonly path?: string }
  readonly doNotFollow?: { readonly path?: string }
}

/** 配置是 CJS（module.exports），动态 import 取 default 即 module.exports */
async function loadOptions(): Promise<Options> {
  const mod = (await import(CONFIG)) as { default?: { options?: Options } }
  return mod.default?.options ?? {}
}

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })))
})

async function cruiseFixture(relativeDirectory: string, files: Record<string, string>): Promise<ICruiseResult> {
  const temporary = await mkdtemp(path.join(tmpdir(), 'poietica-depcruise-'))
  temporaryRoots.push(temporary)
  const root = path.join(temporary, 'poietica')
  const directory = path.join(root, relativeDirectory)
  await mkdir(directory, { recursive: true })
  await Promise.all(
    Object.entries(files).map(async ([name, source]) => {
      const file = path.join(directory, name)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, source)
    }),
  )
  const { forbidden = [], options = {} } = ((await import(CONFIG)) as { default: IConfiguration }).default
  const result = await cruise(
    [relativeDirectory],
    { ...options, baseDir: root, ruleSet: { forbidden }, validate: true },
    options.enhancedResolveOptions,
  )

  if (typeof result.output === 'string') throw new Error('depcruise 应返回结构化结果')
  return result.output
}

function violationsOf(result: ICruiseResult, rule: string): string[] {
  return result.summary.violations
    .filter((violation) => violation.rule.name === rule)
    .map((violation) => violation.from)
}

describe('depcruise 配置的自检', () => {
  test('exclude 不含 dist：@oh-my-pi 的 types 指向 dist，排除它就等于让 omp-confined 失效', async () => {
    const exclude = (await loadOptions()).exclude?.path ?? ''
    expect(exclude).not.toContain('dist')
  })

  test('doNotFollow 含 node_modules / dist：这些是「不往里走」而不是「从图里删掉」', async () => {
    const doNotFollow = (await loadOptions()).doNotFollow?.path ?? ''
    for (const part of ['node_modules', 'dist']) {
      expect(doNotFollow).toContain(part)
    }
  })

  test('omp-confined 规则还在，且例外只有 engine-omp 与 apps/core/scripts', () => {
    const src = readFileSync(CONFIG, 'utf8')
    expect(src).toContain("name: 'omp-confined'")
    expect(src).toContain("pathNot: '^(packages/engine-omp/|apps/core/scripts/)'")
  })

  /*
   * 06 页 A-K1 的验证方式点名规则 `workbench-agnostic`：三个内核包与外壳不得依赖任何
   * `@poietica/feature-*`。这条用例把规则名钉住 —— 规则若改名或被删掉，A-K1 就无从验证。
   */
  test('workbench-agnostic 规则还在：workbench 与三个 *-kernel 都不认识功能', () => {
    const src = readFileSync(CONFIG, 'utf8')
    expect(src).toContain("name: 'workbench-agnostic'")
    expect(src).toContain('^packages/(workbench|core-kernel|host-kernel|ui-kernel)/')
  })

  test('真实解析：setup 只能经区域 index，direct 被拒而 index 合法', async () => {
    const directory = 'features/conversation/src/ui/setup'
    const result = await cruiseFixture(directory, {
      'direct.ts': "import { AssistantSurface } from '../home/assistant-surface'\nvoid AssistantSurface\n",
      'via-index.ts': "import { HomeSurface } from '../home'\nvoid HomeSurface\n",
      '../home/assistant-surface.ts': 'export const AssistantSurface = true\n',
      '../home/index.ts': 'export const HomeSurface = true\n',
    })

    expect(violationsOf(result, 'conversation-area-via-index')).toEqual([`${directory}/direct.ts`])
  })

  test('真实解析：shared 的区域穿透被拒，shared 内部 ../timeline 合法', async () => {
    const directory = 'features/conversation/src/ui/shared/tools'
    const result = await cruiseFixture(directory, {
      'direct.ts':
        "import type { TimelineState } from '../../timeline/timeline-contract'\nexport type Held = TimelineState\n",
      'legal.ts':
        "import type { TimelineState } from '../timeline/timeline-contract'\nexport type Held = TimelineState\n",
      '../../timeline/timeline-contract.ts': 'export interface TimelineState { readonly id: string }\n',
      '../timeline/timeline-contract.ts': 'export interface TimelineState { readonly id: string }\n',
    })

    expect(violationsOf(result, 'conversation-shared-is-leaf')).toEqual([`${directory}/direct.ts`])
  })

  /*
   * setup 是装配层，没有 index：只出不进。曾经 to 列表漏掉 setup，于是 timeline 直取
   * ../setup/context 这种反向穿透不报错（refactor-log「内聚与边界审计」声称已覆盖，配置里没有）。
   */
  test('真实解析：区不得反向 import setup 内部；setup 自己仍可经各区 index', async () => {
    const result = await cruiseFixture('features/conversation/src/ui', {
      'timeline/into-setup.ts': "import { SetupContext } from '../setup/context'\nvoid SetupContext\n",
      'setup/into-area.ts': "import { HomeSurface } from '../home'\nvoid HomeSurface\n",
      'setup/context.ts': 'export const SetupContext = true\n',
      'home/index.ts': 'export const HomeSurface = true\n',
    })

    expect(violationsOf(result, 'conversation-area-via-index')).toEqual([
      'features/conversation/src/ui/timeline/into-setup.ts',
    ])
  })

  /*
   * core-api 的令牌只在 Core 进程的注册表里有主人。ui / ui-api / host / contract 拿它只会得到
   * 一个永远没人注册的令牌 —— 曾经没有任何规则拦这条路（ui 侧的 feature-subentry-ui 只管本功能）。
   */
  test('真实解析：core-api 只在 core 子入口跨功能可用，ui / ui-api / host / contract 被拒', async () => {
    const importFrom = (specifier: string) => `import { FakeServiceToken } from '${specifier}'\nvoid FakeServiceToken\n`
    const result = await cruiseFixture('features', {
      'attachments/src/core-api/index.ts': 'export const FakeServiceToken = true\n',
      'conversation/src/core/legal.ts': importFrom('../../../attachments/src/core-api'),
      'conversation/src/core-api/own.ts': importFrom('../contract'),
      'conversation/src/ui/illegal.ts': importFrom('../../../attachments/src/core-api'),
      'conversation/src/ui-api/illegal.ts': importFrom('../../../attachments/src/core-api'),
      'conversation/src/host/illegal.ts': importFrom('../../../attachments/src/core-api'),
      'conversation/src/contract/illegal.ts': importFrom('../../../attachments/src/core-api'),
      'conversation/src/contract/index.ts': 'export const Dummy = true\n',
    })

    expect(violationsOf(result, 'feature-core-api-cross-process')).toEqual([
      'features/conversation/src/contract/illegal.ts',
      'features/conversation/src/host/illegal.ts',
      'features/conversation/src/ui-api/illegal.ts',
      'features/conversation/src/ui/illegal.ts',
    ])
  })
})
