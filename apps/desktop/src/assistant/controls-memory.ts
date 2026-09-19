import type { SessionConfigControl, SessionConfigMemoryPort } from '@poietica/conversation'
import { createPreference, type Preference, type PreferenceFailure } from '@poietica/external-store'
import { z } from 'zod'

/*
 * 上一次 agent 确认过的那张会话控件表，留到下一次开窗。
 *
 * 只为了第一帧：那张表要等 agent 起来、握手、建锚会话之后才回得来，而这几秒里工具条
 * 是三块空白。盘上这份让第一帧就是完整的样子，随后由 agent 的答复原样换掉。
 *
 * 存的是 agent 的原话（id / label / purpose / current / choices），不是我们重编过的
 * 形状 —— 解码器只认这份形状，读不出就当没有。存坏了不该让界面打不开，所以整份
 * 丢弃而不是逐格兜底：一张缺了 current 的表画出来只会更误导。
 *
 * 与 PermissionPosturePort 的分工：那个记的是「用户希望下次用什么」，这个是「上次
 * agent 说在用哪一档」。两者都对，答的不是同一个问题，所以各存各的。
 */

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

/*
 * 逐格搬一次，而不是把解析结果直接交出去。
 *
 * SessionConfigControl 的每一格都显式写着 undefined（exactOptionalPropertyTypes），
 * 而 zod 解出来的缺席是「键根本不在」—— 两者在类型上不等价，所以缺席的格要自己省掉。
 */
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
