import { describe, expect, test } from 'bun:test'
import { createTestLogger } from '@poietica/test-kit'
import type { McpServerInfo, McpStatus, SkillInfo } from '../../contract'
import type { ExtensionsApi } from '../api'
import { createComposerToolkitSource } from '../composer-toolkit'

/*
 * 加号面板那张名册的来源（extensions 侧）。
 *
 * 这一份钉读法上的几条判据：技能按工作区缓存且只列可用的；**MCP 的名字单从配置读、
 * 状态从活会话读**（只读状态时第一条对话之前恒为空 —— 那正是报障的那一版）；两条
 * 通知各自刷新一格；失败保留旧值等下一次 ensure 重试。它不进 DOM —— 组件那一侧的
 * 形状由 conversation 的 composer-toolkit.test.ts 与面板本身钉。
 */

const skill = (name: string, over: Partial<SkillInfo> = {}): SkillInfo => ({
  id: name,
  name,
  description: `${name} 说明`,
  source: 'user',
  enabled: true,
  path: `C:/skills/${name}`,
  ...over,
})

const status = (name: string, over: Partial<McpStatus> = {}): McpStatus => ({
  name,
  state: 'connected',
  toolCount: 1,
  error: null,
  ...over,
})

/** 配置里的一台服务器（`mcp.list` 收的形状）。 */
const server = (name: string, over: Partial<McpServerInfo> = {}): McpServerInfo => ({
  name,
  transport: 'stdio',
  enabled: true,
  config: { command: 'npx' },
  ...over,
})

interface FakeApi extends Pick<ExtensionsApi, 'skills' | 'mcp'> {
  readonly skillCalls: Array<string | null>
  readonly listCalls: number
  readonly statusCalls: number
}

/** 按脚本回话的假 api：技能与 MCP 各记一趟调用。 */
function fakeApi(
  skills: (workspaceId: string | null) => Promise<readonly SkillInfo[]>,
  mcpList: () => Promise<readonly McpServerInfo[]> = async () => [],
  mcpStatus: () => Promise<readonly McpStatus[]> = async () => [],
): FakeApi {
  const skillCalls: Array<string | null> = []
  const api = {
    skillCalls,
    listCalls: 0,
    statusCalls: 0,
    skills: {
      list: (workspaceId: string | null) => {
        skillCalls.push(workspaceId)
        return skills(workspaceId)
      },
    },
    mcp: {
      list: () => {
        api.listCalls += 1
        return mcpList()
      },
      status: () => {
        api.statusCalls += 1
        return mcpStatus()
      },
    },
  }
  return api as unknown as FakeApi
}

/** 等两趟微任务：一次 .then 落地、一次 finally 收尾。 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('名册来源：读法', () => {
  test('读之前是空名册；ensure 之后两组都上屏', async () => {
    const api = fakeApi(
      async () => [skill('翻译')],
      async () => [server('github')],
      async () => [status('github')],
    )
    const source = createComposerToolkitSource({ api, logger: createTestLogger() })

    expect(source.read('w-1')).toEqual({ skills: [], mcpServers: [] })

    source.ensure('w-1')
    await settle()

    expect(source.read('w-1').skills.map((row) => row.name)).toEqual(['翻译'])
    expect(source.read('w-1').mcpServers.map((row) => row.name)).toEqual(['github'])
  })

  test('内置与未启用的技能不出现', async () => {
    const api = fakeApi(
      async () => [
        skill('本机的'),
        skill('内置的', { source: 'builtin' }),
        skill('停用的', { enabled: false }),
        skill('项目的', { source: 'project' }),
      ],
      async () => [],
    )
    const source = createComposerToolkitSource({ api, logger: createTestLogger() })

    source.ensure(null)
    await settle()

    expect(source.read(null).skills).toEqual([
      { name: '本机的', description: '本机的 说明', source: 'user' },
      { name: '项目的', description: '项目的 说明', source: 'project' },
    ])
  })

  test('技能按工作区缓存：同一格不重复问，换一格再问', async () => {
    const api = fakeApi(
      async (workspaceId) => [skill(workspaceId ?? '入口')],
      async () => [],
    )
    const source = createComposerToolkitSource({ api, logger: createTestLogger() })

    source.ensure('w-1')
    await settle()
    source.ensure('w-1')
    await settle()

    expect(api.skillCalls).toEqual(['w-1'])

    source.ensure('w-2')
    await settle()

    expect(api.skillCalls).toEqual(['w-1', 'w-2'])
    expect(source.read('w-2').skills.map((row) => row.name)).toEqual(['w-2'])
  })

  test('MCP 只有全局一份：换工作区不重读', async () => {
    const api = fakeApi(
      async () => [],
      async () => [server('github')],
      async () => [status('github')],
    )
    const source = createComposerToolkitSource({ api, logger: createTestLogger() })

    source.ensure('w-1')
    await settle()
    source.ensure('w-2')
    await settle()

    expect(api.listCalls).toBe(1)
    expect(api.statusCalls).toBe(1)
    /* 但新工作区那一份合并结果里也带着它。 */
    expect(source.read('w-2').mcpServers.map((row) => row.name)).toEqual(['github'])
  })

  /*
   * 报障的那一版：只读 `mcp.status()`。它汇总的是**活会话**的 mcpManager ——
   * 一条会话都没跑过时恒为空，面板于是什么都不画（真机上「明明有 MCP 却不显示」）。
   * 名单必须从配置读，状态只用来给同一行补「连上没连上」。
   */
  test('还没跑过任何会话（状态为空）时，配置里的服务器照画，画成「未连接」', async () => {
    const api = fakeApi(
      async () => [],
      async () => [server('chrome-devtools')],
      async () => [],
    )
    const source = createComposerToolkitSource({ api, logger: createTestLogger() })

    source.ensure(null)
    await settle()

    expect(source.read(null).mcpServers).toEqual([
      { name: 'chrome-devtools', state: 'disconnected', toolCount: 0, error: null },
    ])
  })

  test('停用的服务器画成「未连接」，即使会话报它连着', async () => {
    const api = fakeApi(
      async () => [],
      async () => [server('停用的', { enabled: false })],
      async () => [status('停用的')],
    )
    const source = createComposerToolkitSource({ api, logger: createTestLogger() })

    source.ensure(null)
    await settle()

    expect(source.read(null).mcpServers[0]?.state).toBe('disconnected')
  })
})

describe('名册来源：刷新与失败', () => {
  test('skills.changed 清技能缓存，按认领过的工作区重读', async () => {
    let rows: readonly SkillInfo[] = [skill('翻译')]
    const api = fakeApi(
      async () => rows,
      async () => [],
    )
    const source = createComposerToolkitSource({ api, logger: createTestLogger() })

    source.ensure('w-1')
    await settle()

    rows = [skill('翻译'), skill('总结')]
    source.skillsChanged()
    await settle()

    expect(source.read('w-1').skills.map((row) => row.name)).toEqual(['翻译', '总结'])
    expect(api.skillCalls).toEqual(['w-1', 'w-1'])
  })

  test('mcp.statusChanged 整份替换，不重读', async () => {
    const api = fakeApi(
      async () => [],
      async () => [server('github'), server('filesystem')],
      async () => [status('github')],
    )
    const source = createComposerToolkitSource({ api, logger: createTestLogger() })

    source.ensure('w-1')
    await settle()

    source.mcpChanged([status('github', { state: 'failed', error: '端口被占' }), status('filesystem')])

    expect(source.read('w-1').mcpServers).toEqual([
      { name: 'github', state: 'failed', toolCount: 1, error: '端口被占' },
      { name: 'filesystem', state: 'connected', toolCount: 1, error: null },
    ])
    expect(api.statusCalls).toBe(1)
  })

  test('Core 重启（reset）之后技能与 MCP 都重读', async () => {
    const api = fakeApi(
      async () => [skill('翻译')],
      async () => [server('github')],
      async () => [status('github')],
    )
    const source = createComposerToolkitSource({ api, logger: createTestLogger() })

    source.ensure('w-1')
    await settle()
    source.reset()
    await settle()

    expect(api.skillCalls).toEqual(['w-1', 'w-1'])
    expect(api.statusCalls).toBe(2)
    expect(api.listCalls).toBe(2)
  })

  test('读失败保留旧值，且不拦下一次 ensure 重试', async () => {
    let fails = true
    const api = fakeApi(
      async () => {
        if (fails) {
          throw new Error('没连上')
        }
        return [skill('翻译')]
      },
      async () => [],
    )
    const source = createComposerToolkitSource({ api, logger: createTestLogger() })

    source.ensure('w-1')
    await settle()

    expect(source.read('w-1').skills).toHaveLength(0)

    fails = false
    source.ensure('w-1')
    await settle()

    expect(source.read('w-1').skills.map((row) => row.name)).toEqual(['翻译'])
  })

  test('在飞的那一趟遇上 skills.changed：作废的回话不许落进来（旧数据不覆盖新数据）', async () => {
    /* 第一趟故意慢：它回来的东西是改之前的名单，落进来就是「改了没生效」。 */
    const gates: Array<(rows: readonly SkillInfo[]) => void> = []
    const api = fakeApi(
      async () =>
        new Promise<readonly SkillInfo[]>((resolve) => {
          gates.push(resolve)
        }),
      async () => [],
    )
    const source = createComposerToolkitSource({ api, logger: createTestLogger() })

    source.ensure('w-1')
    source.skillsChanged()

    /* 两趟都在飞：第一趟（老）与第二趟（新）。先放第二趟，再放第一趟。 */
    await settle()
    expect(gates).toHaveLength(2)
    gates[1]?.([skill('新的')])
    await settle()
    gates[0]?.([skill('旧的')])
    await settle()

    expect(source.read('w-1').skills.map((row) => row.name)).toEqual(['新的'])
  })

  test('订阅只在数据真的变了时被叫到', async () => {
    const api = fakeApi(
      async () => [skill('翻译')],
      async () => [],
    )
    const source = createComposerToolkitSource({ api, logger: createTestLogger() })
    let calls = 0
    source.subscribe(() => {
      calls += 1
    })

    source.ensure('w-1')
    await settle()
    const afterFirst = calls

    /* 同一份数据再读一次（新数组、同样的行）：不该再叫。 */
    source.ensure('w-1')
    await settle()

    expect(afterFirst).toBeGreaterThan(0)
    expect(calls).toBe(afterFirst)
  })
})
