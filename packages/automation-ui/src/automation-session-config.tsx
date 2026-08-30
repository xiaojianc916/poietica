import type { SessionConfigControl, SessionConfigPurpose } from '@poietica/conversation'
import { Select, type SelectOption } from '@poietica/design-system'
import { useMemo } from 'react'

/*
 * 这条自动化用哪个模型、哪档推理、哪个模式。
 *
 * 没有「跟随默认」。上一版拿一个 \u0000 哨兵造出了「没选」这个第三态，那是错的：
 * 一旦「没选」合法，列表要判一次它算什么、编辑器要判一次、运行时下发那段循环
 * 还要判一次 —— 同一个问题被回答三遍，迟早三个答案。agent 报的 current 就是
 * 默认，新建时显示的就是它，保存下去的也是它。
 *
 * 一格都不是手写的：清单来自 useAgentControls（与输入框上那颗胶囊同一个产地），
 * 控件来自 @poietica/design-system 的 Select（Base UI，自带勾号、键盘导航与宽度自适应）。
 * 上一版在这里用 DropdownMenu + RadioGroup 手搓了一遍同样的东西，那是本仓库
 * 已经有的能力被重造了一次。
 *
 * 三个 purpose 就是用户嘴里那三样，协议里本来就是一个闭合枚举，不是三个各写
 * 一遍的特例。将来 agent 多报一类，它自己会出现在最后。
 */

/** 闭合枚举到中文。与 describeTrigger 同一个性质：翻译，不是发明。 */
const PURPOSE_LABELS: Record<SessionConfigPurpose, string> = {
  model: '模型',
  permission: '批准方式',
  thought: '推理强度',
  mode: '模式',
  other: '其它',
}

const ORDER: readonly SessionConfigPurpose[] = ['model', 'thought', 'mode', 'permission', 'other']

function rank(purpose: SessionConfigPurpose): number {
  const found = ORDER.indexOf(purpose)

  return found < 0 ? ORDER.length : found
}

/*
 * 条目不复述组名：与 session-controls 同一条规矩，理由也同一个 —— 上游给取值
 * 起名是按「单独出现」起的（kimi-code 的 thinkingOptionName 逐字是 Thinking
 * 加档位名），而胶囊的可访问名已经说过一遍了。
 */
function labelOf(control: SessionConfigControl, value: string): string {
  const found = control.choices.find((choice) => choice.value === value)

  if (found === undefined) {
    return value
  }

  const prefix = `${control.label} `
  const stripped = found.label.startsWith(prefix) ? found.label.slice(prefix.length) : ''

  return stripped.length > 0 ? stripped : found.label
}

export interface AutomationSessionConfigProps {
  readonly controls: readonly SessionConfigControl[]
  readonly onChange: (controlId: string, value: string) => void
  /** 人明确改过的那些。没改过的项由 control.current 顶上。 */
  readonly value: Readonly<Record<string, string>>
}

export function AutomationSessionConfig({
  controls,
  onChange,
  value,
}: AutomationSessionConfigProps) {
  const rows = useMemo(
    () => [...controls].sort((left, right) => rank(left.purpose) - rank(right.purpose)),
    [controls],
  )

  if (rows.length === 0) {
    /*
     * 还没有和没有，是两件事。候选要等组合根把端口交给 agent-capability-store 才
     * 去问（start(port) 那一趟 #load，#asked 保证只问一遍），所以启动后的头一瞬间
     * 这里必然是空的。
     * 说一句话，比摆三个空下拉诚实。
     */
    return (
      <p className="px-1.5 py-1 text-xs text-muted-foreground">
        还没有拿到 agent 报的可选项。配好 provider 之后，模型、推理强度与模式会出现在这里。
      </p>
    )
  }

  return (
    <>
      {rows.map((control) => (
        <ConfigPill
          control={control}
          key={control.id}
          onChange={onChange}
          picked={value[control.id] ?? control.current}
        />
      ))}
    </>
  )
}

interface ConfigPillProps {
  readonly control: SessionConfigControl
  readonly onChange: (controlId: string, value: string) => void
  readonly picked: string
}

function ConfigPill({ control, onChange, picked }: ConfigPillProps) {
  const options = useMemo<readonly SelectOption[]>(() => {
    const listed = control.choices.map((choice) => ({
      value: choice.value,
      label: labelOf(control, choice.value),
    }))

    /*
     * 存着的取值 agent 现在不报了 —— 照样列出来，并且说出来。
     *
     * 不这么做，Select 找不到这一项就回落到占位文案，人看到的是「选择模型…」，
     * 以为自己从来没设过。静默丢弃是这一类界面最坏的一种失败。
     */
    if (picked.length === 0 || listed.some((option) => option.value === picked)) {
      return listed
    }

    return [...listed, { value: picked, label: `${picked}（agent 未提供）` }]
  }, [control, picked])

  return (
    <Select
      className="max-w-44 bg-sidebar-accent/50 hover:bg-sidebar-accent data-[popup-open]:bg-sidebar-accent"
      data={options}
      onValueChange={(next) => {
        onChange(control.id, next)
      }}
      type={PURPOSE_LABELS[control.purpose]}
      value={picked}
    />
  )
}
