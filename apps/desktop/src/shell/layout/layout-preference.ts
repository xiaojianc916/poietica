import { createPreference, type Preference } from '@poietica/external-store'
import { warn } from '@poietica/problem'
import * as v from 'valibot'
import { clampSidebarWidth, DEFAULT_LAYOUT_INTENT, type LayoutIntent } from './layout-store'

const schema = v.object({
  sidebarOpen: v.fallback(v.boolean(), DEFAULT_LAYOUT_INTENT.sidebarOpen),
  sidebarWidth: v.fallback(
    v.pipe(v.number(), v.finite(), v.transform(clampSidebarWidth)),
    DEFAULT_LAYOUT_INTENT.sidebarWidth,
  ),
  auxiliaryThread: v.fallback(v.nullable(v.string()), DEFAULT_LAYOUT_INTENT.auxiliaryThread),
  /* 辅助列的上限取决于同一份偏好里的侧边栏状态，落界由 store 的 normalize 一处负责。 */
  auxiliaryWidth: v.fallback(v.pipe(v.number(), v.finite()), DEFAULT_LAYOUT_INTENT.auxiliaryWidth),
})
export function createWorkspaceLayoutPreference(): Preference<LayoutIntent> {
  return createPreference({
    key: 'poietica.workspace.layout.v1',
    fallback: DEFAULT_LAYOUT_INTENT,
    decode: (raw) => v.parse(schema, JSON.parse(raw)),
    encode: (value) => JSON.stringify(value),
    onFailure: ({ stage, cause }) => {
      warn(
        stage === 'read' ? '读不出布局偏好，回到默认布局' : '写不进布局偏好，下次启动回到默认布局',
        { scope: 'workspace-layout', cause },
      )
    },
  })
}
