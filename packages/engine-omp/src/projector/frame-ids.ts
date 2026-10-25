/*
 * 正文 / 思维链 / 插话帧的号（frameId）。号必须由 **omp 自己的消息身份** 派生，而不是由
 * 「投影走到第几格」派生：增量与历史两条路的段划分规则不同，按格数数号两边会给出不同的号 ——
 * 整页重取（压缩收口、补发缺口、Core 重启、切回线程）之后，界面上按号记的东西（虚拟列表量高缓存、
 * 展开状态）全部错位到别的行上。工具帧早就是这个做法（`tool.<toolCallId>`），这里补齐其余三种：
 * 助手消息的块 = 轮内第几条助手消息 + content 下标；插话 = 轮内第几句（从 1 数）；
 * 其余上屏的非助手消息单独一个名字空间，不挤占助手消息的序号。
 */
export function assistantFrameId(turn: string, message: number, block: number): string {
  return `${turn}.a${String(message)}.c${String(block)}`
}

export function interjectionFrameId(turn: string, ordinal: number): string {
  return `${turn}.u${String(ordinal)}`
}

export function extraFrameId(turn: string, message: number, block: number): string {
  return `${turn}.x${String(message)}.c${String(block)}`
}
