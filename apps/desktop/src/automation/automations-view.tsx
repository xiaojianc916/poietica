import { useAgentControls } from '@poietica/assistant'
import type { AutomationStore } from '@poietica/automation'
import { AutomationsSurface } from '@poietica/automation/ui'
import { pickWorkspaceRoot } from '@poietica/native-bridge/workspace'
export interface AutomationsViewProps {
  readonly store: AutomationStore
  readonly onOpenThread: (threadId: string, title: string) => void
}
export function AutomationsView({ store, onOpenThread }: AutomationsViewProps) {
  const { controls } = useAgentControls()
  return (
    <AutomationsSurface
      controls={controls}
      defaultTimeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
      onOpenThread={onOpenThread}
      pickWorkspace={pickWorkspaceRoot}
      store={store}
    />
  )
}
