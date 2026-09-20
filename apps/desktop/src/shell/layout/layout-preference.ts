import { createPreference, type Preference } from '@poietica/external-store'
import { warn } from '@poietica/problem'
import { z } from 'zod'
import { DEFAULT_LAYOUT_INTENT, type LayoutIntent } from './layout-store'

/* 每一格坏了就回落到默认值：一份读不动的偏好不该让界面打不开。
 *
 * 两个宽度只验类型，落界由 store 的 normalize 一处负责 —— 侧栏宽度在这里夹一次、
 * 辅助列宽度在那里夹一次的话，同一件事就有两个答案，而辅助列的上限还随窗口走，
 * 这里根本算不出来。 */
const schema = z.object({
  sidebarOpen: z.boolean().catch(DEFAULT_LAYOUT_INTENT.sidebarOpen),
  sidebarWidth: z.number().catch(DEFAULT_LAYOUT_INTENT.sidebarWidth),
  auxiliaryThread: z.string().nullable().catch(DEFAULT_LAYOUT_INTENT.auxiliaryThread),
  auxiliaryWidth: z.number().catch(DEFAULT_LAYOUT_INTENT.auxiliaryWidth),
})
export function createWorkspaceLayoutPreference(): Preference<LayoutIntent> {
  return createPreference({
    key: 'poietica.workspace.layout.v1',
    fallback: DEFAULT_LAYOUT_INTENT,
    decode: (raw) => schema.parse(JSON.parse(raw)),
    encode: (value) => JSON.stringify(value),
    onFailure: ({ stage, cause }) => {
      warn(
        stage === 'read' ? '读不出布局偏好，回到默认布局' : '写不进布局偏好，下次启动回到默认布局',
        { scope: 'workspace-layout', cause },
      )
    },
  })
}
