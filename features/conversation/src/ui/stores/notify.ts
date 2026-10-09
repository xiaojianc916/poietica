import type { DialogService } from '@poietica/ui-kernel'
import type { Thread } from '../../contract'

/*
 * 系统通知与确认框的判据层：**只做判断，不做 IO**。
 *
 * 通知本身走 platform 的 notify.show（07 页 §5E 的通知表：完成 / 失败 / 需要确认三种，
 * 窗口没有焦点时才发，点击通知导航到该线程）；确认框走内核的 DialogsToken。
 * 把「什么时候该说」与「怎么说」分开，是为了让这几条能被直接断言。
 */

/** 窗口没有焦点、且偏好里开着完成通知 —— 两个条件都成立才发 */
export function shouldNotify(focused: boolean, notifyOnCompletion: boolean): boolean {
  return !focused && notifyOnCompletion
}

/** 一轮结束时该说什么（07 页 §5E 的通知表） */
export function completionBody(error: { readonly code: string } | null): string {
  return error === null ? '已完成' : '运行失败'
}

/**
 * 这一条 `turns.state` 是否就是「一轮结束」（07 页 §5E 通知表的判据）。
 *
 * 判据取**前一份状态**：从 running / awaiting 回到 idle 才算结束。只看当前是 idle 会把
 * 首次 `threads.list` 的初始读数也当成一次「结束」，一开软件就弹通知（真机上会报一串
 * 「已完成」）。UI 的其余部分也从不自己推断状态（14 页 §9 第 3 条），这里同一条口径。
 */
export function isTurnSettled(
  previous: 'idle' | 'running' | 'awaiting' | undefined,
  next: 'idle' | 'running' | 'awaiting',
): boolean {
  return (previous === 'running' || previous === 'awaiting') && next === 'idle'
}

/** 「有 N 个对话正在运行」的退出确认；没有运行中的线程时直接放行 */
export async function confirmQuit(dialogs: DialogService, running: number): Promise<boolean> {
  if (running === 0) return true
  return dialogs.confirm({
    title: '退出 Poietica？',
    body: `有 ${String(running)} 个对话正在运行，退出将中断它们。`,
    confirmLabel: '退出',
    danger: true,
  })
}

/** 删除线程：偏好里 confirmBeforeDelete 为真时先确认（文案说明不会删掉文件夹里的文件） */
export async function confirmDeleteThread(
  dialogs: DialogService,
  confirmBeforeDelete: boolean,
  thread: Thread,
): Promise<boolean> {
  if (!confirmBeforeDelete) return true
  return dialogs.confirm({
    title: '删除这个对话？',
    body: `「${thread.title}」的对话记录会被删除。文件夹里的文件不会动。`,
    confirmLabel: '删除',
    danger: true,
  })
}
