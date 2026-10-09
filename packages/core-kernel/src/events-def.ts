/**
 * 进程内事件令牌。这个文件是 neutral 子入口 @poietica/core-kernel/events 的全部内容：
 * 各功能的 core-api（neutral）只从这里 import，因此这里**不得** import 任何 Bun / Node API，
 * 也不得 import foundation 之外的东西。depcruise 规则 contract-pure 只放行这一个文件。
 */
export interface CoreEvent<T> {
  readonly ownerModule: string
  readonly name: string
  readonly __payload?: T
}

/** 在提供方功能的 core-api 里定义，例如 defineCoreEvent<TurnCompleted>('conversation', 'turnCompleted') */
export function defineCoreEvent<T>(ownerModule: string, name: string): CoreEvent<T> {
  return Object.freeze({ ownerModule, name })
}
