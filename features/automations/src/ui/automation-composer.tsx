import './automation-composer.css'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRadioItemIndicator,
  DropdownMenuTrigger,
} from '@poietica/design-system'
import type { ModelRef, Posture } from '@poietica/engine'
import { Brain, Check, ChevronDown, Hand, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useState } from 'react'

/* 编辑器里的指令输入框。legacy 直接摆 conversation 的 AssistantComposer，而那个输入框没经 ui-api 导出、铁律又禁止功能之间
 * import 别的功能的 ui，所以按同一份度量复刻它可见的几格：[data-slot="prompt-input"] 卡片框体、"prompt-input-editor" 正文、
 * "prompt-input-toolbar" 工具条。conversation 把这张卡导出之后，这个文件应当整份删除、改回引用同一份。 */

const POSTURES: readonly { readonly value: Posture; readonly label: string; readonly detail: string }[] = [
  { value: 'ask', label: '每次询问', detail: '编辑外部文件和使用互联网时始终询问' },
  { value: 'auto-edit', label: '自动编辑', detail: '仅对检测到的风险操作请求批准' },
  { value: 'full-access', label: '完全放行', detail: '可不受限制地访问互联网和您电脑上的任何文件' },
]

const GLYPH: Readonly<Record<Posture, typeof Hand>> = {
  ask: Hand,
  'auto-edit': ShieldCheck,
  'full-access': ShieldAlert,
}

export interface ModelChoices {
  readonly models: readonly { readonly ref: ModelRef; readonly label: string }[]
  readonly defaultLabel: string | null
  readonly thinking: readonly { readonly id: string; readonly label: string }[]
}

export interface AutomationComposerProps {
  readonly prompt: string
  readonly onPromptChange: (prompt: string) => void
  readonly posture: Posture
  readonly onPostureChange: (posture: Posture) => void
  readonly model: ModelRef | null
  readonly onModelChange: (model: ModelRef | null) => void
  readonly thinking: string | null
  readonly onThinkingChange: (thinking: string | null) => void
  readonly choices: ModelChoices | null
  readonly placeholder: string
}

const DEFAULT_KEY = '__default__'
const keyOf = (ref: ModelRef | null): string => (ref === null ? DEFAULT_KEY : `${ref.provider}/${ref.id}`)

/* 第一项永远是「默认模型」（存 null，到点才解析，用户改了默认模型任务跟着变）；存着的模型不在表里（被删了、凭据没了）也
 * 照样显示它的 id，不悄悄换掉：到点会报错，用户在这里看得见、改得了。 */
function ModelMenu({
  choices,
  model,
  onModelChange,
}: {
  readonly choices: ModelChoices | null
  readonly model: ModelRef | null
  readonly onModelChange: (model: ModelRef | null) => void
}) {
  const known = choices?.models.find((m) => keyOf(m.ref) === keyOf(model))
  const label = model === null ? '默认模型' : (known?.label ?? `${model.provider}/${model.id}`)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="模型" className="automation-composer__picker" disabled={choices === null}>
        <span className="automation-composer__picker-label">{label}</span>
        <ChevronDown aria-hidden className="automation-composer__picker-chevron" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64" data-assistant-skin>
        <DropdownMenuRadioGroup
          onValueChange={(next) => {
            const picked = choices?.models.find((m) => keyOf(m.ref) === next)
            onModelChange(picked === undefined ? null : picked.ref)
          }}
          value={keyOf(model)}
        >
          <DropdownMenuRadioItem value={DEFAULT_KEY}>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span>默认模型</span>
              <span className="text-xs text-muted-foreground">
                {choices?.defaultLabel === null || choices === null
                  ? '跟随设置里的默认模型'
                  : `跟随设置里的默认模型（现在是 ${choices.defaultLabel}）`}
              </span>
            </span>
            <DropdownMenuRadioItemIndicator>
              <Check aria-hidden />
            </DropdownMenuRadioItemIndicator>
          </DropdownMenuRadioItem>
          {(choices?.models ?? []).map((m) => (
            <DropdownMenuRadioItem key={keyOf(m.ref)} value={keyOf(m.ref)}>
              <span className="min-w-0 flex-1 truncate">{m.label}</span>
              <DropdownMenuRadioItemIndicator>
                <Check aria-hidden />
              </DropdownMenuRadioItemIndicator>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ThinkingMenu({
  choices,
  onThinkingChange,
  thinking,
}: {
  readonly choices: ModelChoices | null
  readonly onThinkingChange: (thinking: string | null) => void
  readonly thinking: string | null
}) {
  const levels = choices?.thinking ?? []
  if (levels.length === 0 && thinking === null) return null
  const label = thinking === null ? '默认' : (levels.find((l) => l.id === thinking)?.label ?? thinking)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="思考强度" className="automation-composer__picker">
        <Brain aria-hidden className="automation-composer__picker-glyph" />
        <span className="automation-composer__picker-label">{label}</span>
        <ChevronDown aria-hidden className="automation-composer__picker-chevron" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44" data-assistant-skin>
        <DropdownMenuRadioGroup
          onValueChange={(next) => {
            onThinkingChange(next === DEFAULT_KEY ? null : next)
          }}
          value={thinking ?? DEFAULT_KEY}
        >
          {[{ id: DEFAULT_KEY, label: '默认' }, ...levels].map((level) => (
            <DropdownMenuRadioItem key={level.id} value={level.id}>
              <span className="min-w-0 flex-1">{level.label}</span>
              <DropdownMenuRadioItemIndicator>
                <Check aria-hidden />
              </DropdownMenuRadioItemIndicator>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AutomationComposer({
  choices,
  model,
  onModelChange,
  onPostureChange,
  onPromptChange,
  onThinkingChange,
  placeholder,
  posture,
  prompt,
  thinking,
}: AutomationComposerProps) {
  const [open, setOpen] = useState(false)
  const current = POSTURES.find((row) => row.value === posture) ?? POSTURES[1]!
  const Mark = GLYPH[posture]

  return (
    <div className="automation-composer" data-slot="prompt-input">
      <div data-slot="prompt-input-body">
        <textarea
          aria-label="指令"
          className="assistant-prompt-editor"
          data-slot="prompt-input-editor"
          onChange={(event) => onPromptChange(event.currentTarget.value)}
          placeholder={placeholder}
          rows={1}
          spellCheck={false}
          value={prompt}
        />
      </div>

      <div data-slot="prompt-input-toolbar">
        <div data-slot="prompt-input-tools">
          <DropdownMenu onOpenChange={setOpen} open={open}>
            <DropdownMenuTrigger
              aria-label="姿态"
              className="assistant-posture"
              data-alert={posture === 'full-access' ? 'true' : undefined}
            >
              <Mark aria-hidden="true" />
              <span className="assistant-posture__label">{current.label}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="assistant-posture-menu w-72" data-assistant-skin>
              <DropdownMenuRadioGroup
                onValueChange={(next) => {
                  onPostureChange(next as Posture)
                }}
                value={posture}
              >
                {POSTURES.map((row) => (
                  <DropdownMenuRadioItem key={row.value} value={row.value}>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span>{row.label}</span>
                      <span className="text-xs text-muted-foreground">{row.detail}</span>
                    </span>
                    <DropdownMenuRadioItemIndicator>
                      <Check aria-hidden />
                    </DropdownMenuRadioItemIndicator>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <span className="assistant-toolbar__spacer" />

        <ThinkingMenu choices={choices} onThinkingChange={onThinkingChange} thinking={thinking} />
        <ModelMenu choices={choices} model={model} onModelChange={onModelChange} />
      </div>
    </div>
  )
}
