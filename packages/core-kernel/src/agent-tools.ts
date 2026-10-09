import type { AgentEngine, EngineToolSpec } from '@poietica/engine'
import { AppError, SystemErrorCode } from '@poietica/foundation'

export interface AgentToolRegistry {
  /** 只能在 setup 期间调用；工具存活到进程结束（omp 会话创建后工具集不可变） */
  register(spec: EngineToolSpec): void
}

const TOOL_NAME = /^[a-z][a-z0-9_]{2,63}$/

export function createAgentToolRegistry(
  engine: AgentEngine,
  moduleId: string,
  isFrozen: () => boolean,
): AgentToolRegistry {
  return {
    register(spec) {
      if (isFrozen()) {
        throw new AppError(SystemErrorCode.conflict, `${moduleId} 在 setup 之后注册工具 ${spec.name}：工具集已冻结`)
      }
      if (!TOOL_NAME.test(spec.name)) {
        throw new AppError(SystemErrorCode.invalidParams, `工具名不合法：${spec.name}（只能用小写字母、数字、下划线）`)
      }
      // 重名由引擎抛错；返回的 Disposable 不需要保存：工具存活到进程结束
      engine.registerTool(spec)
    },
  }
}
