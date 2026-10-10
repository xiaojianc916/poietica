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

/*
 * 自动化编辑器的指令输入框。
 *
 * legacy 这一格直接把 conversation 的 `AssistantComposer` 摆进编辑页
 * （`packages/automation/src/ui/automation-editor.tsx` 的「指令」一栏）。新架构里
 * conversation 的输入框没有经 ui-api 导出，而铁律禁止功能之间直接 import 别的功能的
 * ui —— 所以这里按同一份度量复刻它可见的那几格：
 *
 *   [data-slot="prompt-input"]        卡片框体（边、圆角、底、影，读 --cp-* 令牌）
 *   [data-slot="prompt-input-editor"] 正文，占位文案由调用方给
 *   [data-slot="prompt-input-toolbar"] 工具条：姿态胶囊 + 模型胶囊
 *
 * 与 legacy 的差别只有「工具条里能点的东西」：
 *   - 姿态由契约的 Posture（ask / auto-edit / full-access）驱动，三档与对话页那三颗
 *     胶囊同一份说法；
 *   - 模型与思考强度（审查 R-16）：可选项读 conversation 的 `controls.draft`（只读 RPC，
 *     对话入口页的选择器读的也是它），由编辑器取来经 choices 交进来。
 *
 * conversation 把这张卡（或它的 ui-api 资产）导出来之后，这个文件应当整份删除、
 * 改回引用同一份 —— 到那时两者不会再有漂移的可能。
 */

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

/** 模型与思考强度的可选项（conversation 的 controls.draft，见 api.ts）；null = 还没读到 */
export interface ModelChoices {
  readonly models: readonly { readonly ref: ModelRef; readonly label: string }[]
  /** 「默认模型」此刻解析成哪一个（只用来写旁注） */
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

/*
 * 模型那一格（审查 R-16）：第一项永远是「默认模型」—— 存成 null，到点时才解析，用户改了
 * 默认模型任务跟着变；其余是此刻可用的模型。存着的模型不在表里（被删了、凭据没了）也照
 * 样显示它的 id，不悄悄换掉：到点会报错，用户在这里看得见、改得了。
 */
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
              <Check aria-hidden className="size-3.5" />
            </DropdownMenuRadioItemIndicator>
          </DropdownMenuRadioItem>
          {(choices?.models ?? []).map((m) => (
            <DropdownMenuRadioItem key={keyOf(m.ref)} value={keyOf(m.ref)}>
              <span className="min-w-0 flex-1 truncate">{m.label}</span>
              <DropdownMenuRadioItemIndicator>
                <Check aria-hidden className="size-3.5" />
              </DropdownMenuRadioItemIndicator>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/* 思考强度：只在这个模型有档位时出现；「默认」存 null。 */
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
                <Check aria-hidden className="size-3.5" />
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
                      <Check aria-hidden className="size-3.5" />
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
