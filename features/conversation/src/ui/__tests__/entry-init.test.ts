import { describe, expect, test } from 'bun:test'
import type { SessionConfigControl } from '../agent/config'
import { entryThreadInitOf } from '../entry-init'

/*
 * 入口页发送时带进 `threads.create` 的那几格（07 页 §5E 的发送流程）。
 *
 * 真机故障：入口页显示 DeepSeek-V4.1-Flash，发送后会话文件里是 deepseek-v4-pro。
 * 根因是这一层此前只把「用户手改过的草稿」带进去：没动过选择器时一个字段都不传，
 * 引擎收不到模型，就按内置目录自己的规则另挑了一条。
 */

function control(id: string, current: string): SessionConfigControl {
  return { id, label: id, purpose: id === 'thought' ? 'thought' : 'model', current, choices: [] }
}

const CONTROLS: readonly SessionConfigControl[] = [
  control('model', 'deepseek/deepseek-flash'),
  control('thought', 'high'),
]

describe('入口页的线程初始化', () => {
  test('没动过选择器时，屏幕上的模型与档位照样带进 threads.create', () => {
    const init = entryThreadInitOf({
      workspaceId: 'w1',
      draft: {},
      controls: CONTROLS,
      posture: 'full-access',
    })

    expect(init).toEqual({
      workspaceId: 'w1',
      posture: 'full-access',
      model: { provider: 'deepseek', id: 'deepseek-flash' },
      thinking: 'high',
    })
  })

  test('用户手改过的格子压过草稿表', () => {
    const init = entryThreadInitOf({
      workspaceId: 'w1',
      draft: { model: { provider: 'openai', id: 'gpt-5' }, thinking: 'low' },
      controls: CONTROLS,
      posture: 'ask',
    })

    expect(init?.model).toEqual({ provider: 'openai', id: 'gpt-5' })
    expect(init?.thinking).toBe('low')
  })

  /*
   * 换了模型、草稿表还没重读回来时，表里那份档位属于**上一条模型** —— 它可能正是
   * 新模型没有的那一档，不传比传错好。
   */
  test('模型不一致时档位不跟着旧表走', () => {
    const init = entryThreadInitOf({
      workspaceId: 'w1',
      draft: { model: { provider: 'openai', id: 'gpt-5' } },
      controls: CONTROLS,
      posture: 'ask',
    })

    expect(init?.model).toEqual({ provider: 'openai', id: 'gpt-5' })
    expect(init).not.toHaveProperty('thinking')
  })

  test('工作区还没回来时开不出对话（返回 null，不编一个空工作区）', () => {
    expect(entryThreadInitOf({ workspaceId: undefined, draft: {}, controls: CONTROLS })).toBeNull()
  })

  test('草稿表报不出模型时不传（值为 null 的字段不传）', () => {
    const init = entryThreadInitOf({
      workspaceId: 'w1',
      draft: {},
      controls: [control('model', ''), control('thought', 'high')],
      posture: 'auto-edit',
    })

    expect(init).toEqual({ workspaceId: 'w1', posture: 'auto-edit' })
  })
})
