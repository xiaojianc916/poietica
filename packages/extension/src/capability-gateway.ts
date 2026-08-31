import type { AgentCapability, AgentCapabilityReport } from '@poietica/contract'

/*
 * 本机能力账本的端口：装到哪一步由本机 kap 说。
 *
 * DTO 不在这里声明 —— 产地是 Rust，经由生成绑定过来。
 */

export interface CapabilityGateway {
  readCapabilities(): Promise<AgentCapabilityReport>
  /** 跟随已有后台任务，必要时启动安装，并在落定后返回最终状态。 */
  installCapability(capabilityId: string): Promise<AgentCapability>
}
