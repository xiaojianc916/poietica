import type { AgentCapability } from '@poietica/contract'

/* KAP 是能力就绪与安装的唯一事实源；连接生命周期由原生适配器处理。 */
export interface CapabilityGateway {
  readCapabilities(): Promise<readonly AgentCapability[]>
  /** 跟随已有后台任务，必要时启动安装，并在落定后返回最终状态。 */
  installCapability(capabilityId: string): Promise<AgentCapability>
}
