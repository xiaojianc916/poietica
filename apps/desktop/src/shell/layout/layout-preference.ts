import { createPreference, type Preference } from '@poietica/external-store'
import { warn } from '@poietica/problem'
import * as v from 'valibot'
import {
  clampAuxiliaryWidth,
  clampSidebarWidth,
  DEFAULT_LAYOUT_INTENT,
  type LayoutIntent,
} from './layout-store'

const width = (clamp: (value: number) => number, fallback: number) =>
  v.fallback(v.pipe(v.number(), v.finite(), v.transform(clamp)), fallback)
const schema = v.object({
  sidebarOpen: v.fallback(v.boolean(), DEFAULT_LAYOUT_INTENT.sidebarOpen),
  sidebarWidth: width(clampSidebarWidth, DEFAULT_LAYOUT_INTENT.sidebarWidth),
  auxiliaryThread: v.fallback(v.nullable(v.string()), DEFAULT_LAYOUT_INTENT.auxiliaryThread),
  auxiliaryWidth: width(clampAuxiliaryWidth, DEFAULT_LAYOUT_INTENT.auxiliaryWidth),
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
