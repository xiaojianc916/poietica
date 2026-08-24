import type { SessionLink } from '@poietica/agent-contract'

const SECOND_MS = 1_000

/** 详情最长这么多字：一句提示不该把一整行挤走。 */
const REASON_MAX = 72

/** 秒，向上取整，至少 1 —— 倒计时不显示 0s。 */
function seconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / SECOND_MS))
}

/** 原话压成一行，长了截断。 */
function tidy(reason: string): string {
  const flat = reason.replace(/\s+/g, ' ').trim()

  return flat.length > REASON_MAX ? `${flat.slice(0, REASON_MAX)}…` : flat
}

/**
 * 链路态说成一句话；null 表示没有话要说。
 *
 * 一行三段：在做什么、下一次什么时候、上一次为什么没成 —— 与 codex 的
 * "Reconnecting... n/max" 加详情行、kimi 的 "Retrying (n/m) · … · in Xs" 同形。
 * 成句是纯函数，脱离 React 就能测；组件只负责把这句话画出来。
 *
 * now 与 since / retryAt 同在墙钟域（原生侧 now_millis 写下的 epoch 毫秒）。
 */
export function linkNotice(link: SessionLink, now: number): string | null {
  switch (link.state) {
    case 'linked':
      return null

    case 'waiting':
      return `模型仍未响应 · 已等待 ${String(seconds(Math.max(now - link.since, 0)))}s`

    case 'retrying':
      return (
        `正在重新连接 ${link.attempt}/${link.of} · ` +
        `${seconds(Math.max(link.retryAt - now, 0))}s 后重试 · ${tidy(link.reason)}`
      )
  }
}
