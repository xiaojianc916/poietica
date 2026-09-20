import type { SessionConfigControl, SessionConfigMemoryPort } from '@poietica/conversation'
import { createPreference, type Preference, type PreferenceFailure } from '@poietica/external-store'
import { z } from 'zod'

/* 缓存上一次 agent 确认的会话控件表，只为第一帧；存 agent 的原话形状，解码不出就整份丢弃。 */

const Choice = z.object({
  value: z.string(),
  label: z.string(),
  detail: z.string().optional(),
})

const Control = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string().optional(),
  purpose: z.enum(['model', 'thought', 'permission', 'mode', 'other']),
  appliesOnSubmit: z.literal(true).optional(),
  current: z.string(),
  choices: z.array(Choice),
})

const Controls = z.array(Control)

/* 逐格搬而不是直接交出解析结果：exactOptionalPropertyTypes 下显式 undefined 与 zod 缺席的「键不在」类型不等价。 */
function decode(raw: string): readonly SessionConfigControl[] {
  return Controls.parse(JSON.parse(raw)).map((control) => ({
    id: control.id,
    label: control.label,
    purpose: control.purpose,
    current: control.current,
    choices: control.choices.map((choice) => ({
      value: choice.value,
      label: choice.label,
      ...(choice.detail === undefined ? {} : { detail: choice.detail }),
    })),
    ...(control.detail === undefined ? {} : { detail: control.detail }),
    ...(control.appliesOnSubmit === undefined ? {} : { appliesOnSubmit: true as const }),
  }))
}

export function createControlsMemory(
  onFailure: (failure: PreferenceFailure) => void,
): SessionConfigMemoryPort {
  const stored: Preference<readonly SessionConfigControl[]> = createPreference({
    key: 'poietica.session-controls',
    fallback: [],
    decode,
    encode: (controls) => (controls.length === 0 ? null : JSON.stringify(controls)),
    onFailure,
  })

  return {
    read: stored.read,
    write: stored.write,
  }
}
