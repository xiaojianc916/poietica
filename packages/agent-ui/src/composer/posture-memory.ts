import { permissionControlOf, permissionPostureOf } from '@poietica/agent'
import type { SessionConfigControl } from '@poietica/agent-contract'
import { useEffect, useRef } from 'react'

/*
 * 挂起中的批准方式。
 *
 * mode 与批准方式共用同一个控制值（permissionControlOf）：进 plan 时它被覆写成
 * 'plan'，批准方式从协议值里消失 —— 但它只是被挂起，退出 plan 时要原样还回去。
 * 这份记忆因此只能归我们这一侧（agent 那边已经丢了）：控制值是批准方式就刷新
 * 记忆，是 plan 这类非批准值就保持。两个消费方（批准胶囊、模式胶囊）读同一条
 * 控制流，记忆必然一致。
 */
export function usePostureMemory(controls: readonly SessionConfigControl[]): string | null {
  const last = useRef<string | null>(null)
  const current = permissionControlOf(controls)?.current

  useEffect(() => {
    if (current !== undefined && permissionPostureOf(current) !== undefined) {
      last.current = current
    }
  }, [current])

  if (current !== undefined && permissionPostureOf(current) !== undefined) {
    return current
  }

  return last.current
}
