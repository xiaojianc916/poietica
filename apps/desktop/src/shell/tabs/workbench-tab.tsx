import { PixelLoader } from '@poietica/design-system'
import type { WorkbenchTabId, WorkbenchTabViewModel } from '@poietica/workspace'
import { encodeWorkbenchTabDomId } from '@poietica/workspace'
import { X } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { surfaceIcon } from '../surfaces/surface-icons'
import type { WorkbenchTabReorderBindings } from './use-interactions'

interface WorkbenchTabProps {
  readonly model: WorkbenchTabViewModel

  readonly targetIndex: number

  readonly reorder: WorkbenchTabReorderBindings

  readonly isDragging: boolean

  readonly isRunning: boolean

  readonly onActivate: (tabId: WorkbenchTabId) => void

  readonly onRequestClose: (tabId: WorkbenchTabId) => void

  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, tabId: WorkbenchTabId) => void

  readonly registerTab: (tabId: WorkbenchTabId, element: HTMLButtonElement | null) => void
}

export function WorkbenchTab({
  model,
  targetIndex,
  reorder,
  isDragging,
  isRunning,
  onActivate,
  onRequestClose,
  onKeyDown,
  registerTab,
}: WorkbenchTabProps) {
  const encodedId = encodeWorkbenchTabDomId(model.id)

  return (
    <div
      className="chrome-workbench-tab"
      data-active={model.isActive ? 'true' : 'false'}
      {...(isDragging ? { 'data-dragging': 'true' } : {})}
      onLostPointerCapture={reorder.onLostPointerCapture}
      onMouseDown={(event) => {
        if (event.button === 1 && model.canClose) {
          event.preventDefault()

          onRequestClose(model.id)
        }
      }}
      onPointerCancel={reorder.onPointerCancel}
      onPointerDown={(event) => {
        reorder.onPointerDown(event, model, targetIndex)
      }}
      onPointerLeave={(event) => {
        event.currentTarget.removeAttribute('data-suppress-hover')

        reorder.onPointerLeave(event)
      }}
      onPointerMove={reorder.onPointerMove}
      onPointerUp={reorder.onPointerUp}
      role="presentation"
    >
      <div aria-hidden="true" className="chrome-workbench-tab__active-shape">
        <ActiveTabCap side="left" />

        <span className="chrome-workbench-tab__active-center" />

        <ActiveTabCap side="right" />
      </div>

      <span aria-hidden="true" className="chrome-workbench-tab__separator" />

      <div className="chrome-workbench-tab__content">
        <button
          aria-busy={isRunning}
          aria-selected={model.isActive}
          className="chrome-workbench-tab__activation"
          id={`workbench-tab-${encodedId}`}
          onClick={() => {
            onActivate(model.id)
          }}
          onKeyDown={(event) => {
            onKeyDown(event, model.id)
          }}
          ref={(element) => {
            registerTab(model.id, element)
          }}
          role="tab"
          tabIndex={model.isActive ? 0 : -1}
          title={model.title}
          type="button"
        >
          <TabIcon isRunning={isRunning} model={model} />

          <span className="chrome-workbench-tab__title">{model.title}</span>
        </button>

        <TabEndAction model={model} onRequestClose={onRequestClose} />
      </div>
    </div>
  )
}

function TabEndAction({
  model,
  onRequestClose,
}: {
  readonly model: WorkbenchTabViewModel

  readonly onRequestClose: (tabId: WorkbenchTabId) => void
}) {
  if (!model.canClose) {
    return null
  }

  return (
    <div className="chrome-workbench-tab__end">
      <button
        aria-label={`关闭 ${model.title}`}
        className="chrome-workbench-tab__close"
        onClick={(event) => {
          event.stopPropagation()

          onRequestClose(model.id)
        }}
        tabIndex={-1}
        type="button"
      >
        <X aria-hidden="true" />
      </button>
    </div>
  )
}

function ActiveTabCap({ side }: { readonly side: 'left' | 'right' }) {
  return (
    <svg
      aria-hidden="true"
      className={`chrome-workbench-tab__active-cap chrome-workbench-tab__active-cap--${side}`}
      preserveAspectRatio="xMinYMin meet"
      viewBox="0 0 20 32"
    >
      <path
        className="chrome-workbench-tab__active-cap-fill"
        d="M0 32C5.5 32 9.5 28 9.5 23V10C9.5 5.6 13.1 2 17.5 2H20V32Z"
      />

      <path
        className="chrome-workbench-tab__active-cap-outline"
        d="M0 31.5C5.5 31.5 9.5 27.7 9.5 23V10C9.5 5.9 13.1 2.5 17.5 2.5H20"
      />
    </svg>
  )
}

function TabIcon({
  isRunning,
  model,
}: {
  readonly isRunning: boolean

  readonly model: WorkbenchTabViewModel
}) {
  if (isRunning) {
    return <PixelLoader className="chrome-workbench-tab__icon" />
  }

  const Glyph =
    model.kind === 'conversation' || model.surfaceId === 'ai'
      ? surfaceIcon('ai')
      : surfaceIcon(model.surfaceId)

  return <Glyph aria-hidden="true" className="chrome-workbench-tab__icon" />
}
