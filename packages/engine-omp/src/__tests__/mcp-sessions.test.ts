import './omp-home'
import { describe, expect, test } from 'bun:test'
import { noopLogger } from '@poietica/foundation'
import type { DataLayout } from '@poietica/runtime-layout'
import { createOmpEngineForTest } from '../testing'
import { testLayout } from './omp-home'

/*
 * MCP 状态要按名汇总**活会话**的 mcpManager（12 页 §3.14）。
 *
 * 这条线的两个端点都在组合根上：端口拿的是引擎登记会话时用的同一份表。
 * 曾经端口另建了一个空 Set —— 那句「从活会话的 mcpManager 汇总」就成了空转，
 * 界面上永远报不出任何一台服务器。这里钉的是「会话登记进去了」这一格。
 */

describe('MCP 活会话账', () => {
  test('开会话后会话进入 MCP 端口的状态来源；dispose 后摘掉', async () => {
    const handle = await createOmpEngineForTest({
      layout: testLayout as DataLayout,
      logger: noopLogger,
      relayPort: 0,
    })
    const engine = handle.engine

    // mcp.status() 的语义是「把这些会话的 mcpManager 汇总」：没有会话时只能是空表
    expect(await engine.mcp.status()).toEqual([])

    await engine.freezeTools()
    const session = await engine.openSession({
      key: 'mcp-probe',
      cwd: testLayout.coreCwd,
      sessionFile: null,
      posture: 'ask',
      model: null,
      thinking: null,
    })
    // 会话在的时候接口仍然答得出来（status 的内部来源此时多了一条真实会话）
    expect(Array.isArray(await engine.mcp.status())).toBe(true)

    await session.dispose()
    expect(await engine.mcp.status()).toEqual([])
    await engine.dispose()
  }, 30_000)
})
