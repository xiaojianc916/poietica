import { createPreference, type Preference } from '@poietica/external-store'
import { warn } from '@poietica/problem'
import { z } from 'zod'
import { clampSidebarWidth, DEFAULT_LAYOUT_INTENT, type LayoutIntent } from './layout-store'

/* 每一格坏了就回落到默认值：一份读不动的偏好不该让界面打不开。 */
const schema = z.object({
  sidebarOpen: z.boolean().catch(DEFAULT_LAYOUT_INTENT.sidebarOpen),
  sidebarWidth: z.number().transform(clampSidebarWidth).catch(DEFAULT_LAYOUT_INTENT.sidebarWidth),
  auxiliaryThread: z.string().nullable().catch(DEFAULT_LAYOUT_INTENT.auxiliaryThread),
  /* 辅助列的上限取决于同一份偏好里的侧边栏状态，落界由 store 的 normalize 一处负责。 */
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
