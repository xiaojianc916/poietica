import type { SessionConfigControl } from '@poietica/agent-contract'

/*
 * 批准方式：这个产品对「agent 能自己动手到什么程度」的取值域。
 *
 * 取值是发给 agent 的那个值（kap 的 POST /sessions/{id}/profile），说法是产品自己
 * 的 —— agent 报回来的 label 是它的开发词汇，把开发词汇画在输入框旁边等于让人去
 * 背别人的实现细节。
 *
 * 表是封闭的，并且按「放权从少到多」排：这一列的次序就是屏幕上的次序，也是「往下
 * 一格更危险」这句话的唯一出处。agent 报了但不在表里的档位不画 —— 一个我们说不出
 * 它意味着什么的档位，用户无法为它负责。
 */
export interface PermissionPosture {
  readonly value: string
  readonly title: string
  readonly detail: string
  /** 胶囊上的短名：工具条里只有一行的宽度。 */
  readonly pill: string
  /** 需要提醒的那一档。样式表按它上色，颜色不写在这里。 */
  readonly alerts: boolean
}

const POSTURES: readonly PermissionPosture[] = [
  {
    value: 'manual',
    title: '请求批准',
    detail: '编辑外部文件和使用互联网时始终询问',
    pill: '请求批准',
    alerts: false,
  },
  {
    value: 'yolo',
    title: '帮我批准',
    detail: '仅对检测到的风险操作请求批准',
    pill: '帮我批准',
    alerts: false,
  },
  {
    value: 'auto',
    title: '完全访问权限',
    detail: '可不受限制地访问互联网和您电脑上的任何文件',
    pill: '完全访问',
    alerts: true,
  },
]

/** 这张表里那一格批准方式。没有就是这家 agent 不提供。 */
export function permissionControlOf(
  controls: readonly SessionConfigControl[],
): SessionConfigControl | undefined {
  return controls.find((control) => control.purpose === 'permission')
}

/** 画得出来的那几档：产品认得，agent 也确实提供。 */
export function permissionPosturesOf(control: SessionConfigControl): readonly PermissionPosture[] {
  return POSTURES.filter((posture) =>
    control.choices.some((choice) => choice.value === posture.value),
  )
}

export function permissionPostureOf(value: string): PermissionPosture | undefined {
  return POSTURES.find((posture) => posture.value === value)
}

/*
 * 这一次点击算不算在改批准方式。
 *
 * 两台 store（锚会话与单条对话）共用这一句判据：判据写错一半，持久意图就只有
 * 一半能落盘 —— 此前锚会话那一侧按 purpose==='mode' 判，点击永远到不了存储。
 */
export function isPermissionPostureChange(control: SessionConfigControl, value: string): boolean {
  return control.purpose === 'permission' && permissionPostureOf(value) !== undefined
}

/*
 * 持久意图与 agent 此刻报的值不一致时，该补发的那个值。
 *
 * 三道闸：意图存在、与现状不同、agent 确实提供它。缺一条就什么都不发 —— 发一个
 * agent 给不出的值只会换回一次错误，而那次错误会被当成「改不动」报给用户。
 */
export function postureAlignment(
  control: SessionConfigControl,
  intent: string | undefined,
): string | undefined {
  if (intent === undefined || intent === control.current) {
    return undefined
  }

  return permissionPosturesOf(control).some((posture) => posture.value === intent)
    ? intent
    : undefined
}

/*
 * 表刚落地时该补发的那个决定。锚会话与单条对话的两条表到达路径共用它；
 * 返回 undefined 就什么都不发。
 */
export function pendingPostureAlignment(
  controls: readonly SessionConfigControl[],
  intent: string | undefined,
): { control: SessionConfigControl; wanted: string } | undefined {
  const control = permissionControlOf(controls)

  if (control === undefined) {
    return undefined
  }

  const wanted = postureAlignment(control, intent)

  return wanted === undefined ? undefined : { control, wanted }
}
