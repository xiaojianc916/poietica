import type { SessionConfigControl } from '@poietica/agent-contract'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRadioItemIndicator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@poietica/ui'
import { memo, useMemo } from 'react'
import { AttachIcon, CheckIcon, CloseIcon, PlusIcon, ToolIcon } from '../primitives/icons'
import { COMPOSER_MODES, type ComposerMode } from './modes'
import { usePromptInputActions, usePromptInputModes } from './prompt-input'

/*
 * 加号那一侧：往这一句里加什么。
 *
 * 「这一句怎么被批准执行」不在这里 —— 那是一颗常显的胶囊（permission-picker），
 * 藏进菜单意味着人必须先点开才知道自己此刻授了多大的权。
 *
 * 能力那几行不是这里编出来的：它们是 agent 报的 purpose === 'other' 的选择器。
 * agent 没报就没有那一行 —— 画一行点不动的灰字等于告诉用户"这里坏了"。
 *
 * 不来自 agent 的行有两类：「添加文件」与输入姿态（目录在 modes.tsx）。两者都归
 * 输入框：PromptInput 持有文件选择器与姿态的开关。
 *
 * 弹层行为全部归 Base UI（设计系统的 DropdownMenu）：Portal、方向键、打字选中、
 * Esc 逐级关闭、焦点归还。这里只给皮肤与几何。
 */

export interface ComposerActionsProps {
  readonly controls: readonly SessionConfigControl[]
  readonly onSelectControl: (controlId: string, value: string) => void
}

/*
 * 记住不重建，与工具条里另外两簇同一条规矩：同一份入参、同一种分流、同样是一个
 * 菜单根加 N 个子菜单根。controls 只在 agent 报新表时换引用。
 */
export const ComposerActions = memo(function ComposerActions({
  controls,
  onSelectControl,
}: ComposerActionsProps) {
  /* 动作引用终身稳定：这里取文件选择器，姿态开关由各行自己取。 */
  const { openFilePicker } = usePromptInputActions()

  const extras = useMemo(
    () => controls.filter((control) => control.purpose === 'other'),
    [controls],
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="添加内容" className="assistant-control--ghost">
        <PlusIcon aria-hidden="true" />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        className="assistant-plus-menu assistant-menu-surface"
        data-assistant-skin
        side="top"
        sideOffset={6}
      >
        <div className="assistant-plus-menu__group">
          <div className="assistant-plus-menu__heading">添加</div>

          <DropdownMenuItem className="assistant-plus-menu__item" onClick={openFilePicker}>
            <AttachIcon aria-hidden="true" />

            <span className="assistant-plus-menu__label">添加文件</span>

            <kbd className="assistant-plus-menu__hint">Ctrl+U</kbd>
          </DropdownMenuItem>

          {COMPOSER_MODES.map((mode) => (
            <ModeRow key={mode.id} mode={mode} />
          ))}

          {extras.map((control) => (
            <DropdownMenuSub key={control.id}>
              <DropdownMenuSubTrigger className="assistant-plus-menu__item">
                <ToolIcon aria-hidden="true" />

                <span className="assistant-plus-menu__label">{control.label}</span>
              </DropdownMenuSubTrigger>

              <DropdownMenuSubContent
                align="start"
                className="assistant-plus-menu assistant-menu-surface"
                data-assistant-skin
                side="right"
              >
                <DropdownMenuRadioGroup
                  className="assistant-plus-menu__group"
                  onValueChange={(value) => {
                    if (value === control.current) {
                      return
                    }
                    onSelectControl(control.id, value)
                  }}
                  value={control.current}
                >
                  {control.choices.map((choice) => (
                    <DropdownMenuRadioItem
                      className="assistant-plus-menu__item"
                      key={choice.value}
                      value={choice.value}
                    >
                      <span className="assistant-plus-menu__label">{choice.label}</span>

                      {choice.detail === undefined ? null : (
                        <span className="assistant-plus-menu__detail">{choice.detail}</span>
                      )}

                      <DropdownMenuRadioItemIndicator className="assistant-plus-menu__tick">
                        <CheckIcon aria-hidden="true" />
                      </DropdownMenuRadioItemIndicator>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
})

/* 一行姿态：图标、名字、一句淡描述；开着的那行最右打勾。 */
function ModeRow({ mode }: { readonly mode: ComposerMode }) {
  const { toggleMode } = usePromptInputActions()
  const active = usePromptInputModes().some((held) => held.id === mode.id)

  return (
    <DropdownMenuItem
      className="assistant-plus-menu__item"
      onClick={() => {
        toggleMode(mode)
      }}
    >
      {mode.icon}

      <span className="assistant-plus-menu__label">{mode.label}</span>

      <span className="assistant-plus-menu__desc">{mode.description}</span>

      {active ? (
        <span className="assistant-plus-menu__tick">
          <CheckIcon aria-hidden="true" />
        </span>
      ) : null}
    </DropdownMenuItem>
  )
}

/*
 * 生效姿态的胶囊，站在批准方式旁边：一颗一条，点它就摘掉。
 * 状态唯一所有者是 PromptInput，这里只画投影；摘除与菜单再点一次
 * 走同一条写入路径（toggleMode）。
 */
export function ComposerModeChips() {
  const { toggleMode } = usePromptInputActions()
  const modes = usePromptInputModes()

  return modes.map((mode) => (
    <button
      aria-label={`关闭${mode.label}`}
      className="assistant-mode-chip"
      key={mode.id}
      onClick={() => {
        toggleMode(mode)
      }}
      type="button"
    >
      <CloseIcon aria-hidden="true" />

      <span className="assistant-mode-chip__label">{mode.label}</span>
    </button>
  ))
}
