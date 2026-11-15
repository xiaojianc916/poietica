import type { SessionConfigControl } from './config'

/*
 * 取值就是发给 agent 的那个值本身，说法是产品自己的 —— agent 报回来的 label 是它的开发词汇，画在输入框旁边等于让人去背别人的实现细节。
 * 表是封闭的，按「人的介入从多到少」排：这一列的次序就是屏幕上的次序，也是「往下一格更危险」的唯一出处。agent 报了但不在表里的档位不画。
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
    value: 'readonly',
    title: '只读',
    detail: '只读取文件；写入与命令都拒绝',
    pill: '只读',
    alerts: false,
  },
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
export function permissionControlOf(controls: readonly SessionConfigControl[]): SessionConfigControl | undefined {
  return controls.find((control) => control.purpose === 'permission')
}

/** 画得出来的那几档：产品认得，agent 也确实提供。 */
export function permissionPosturesOf(control: SessionConfigControl): readonly PermissionPosture[] {
  return POSTURES.filter((posture) => control.choices.some((choice) => choice.value === posture.value))
}

export function permissionPostureOf(value: string): PermissionPosture | undefined {
  return POSTURES.find((posture) => posture.value === value)
}
