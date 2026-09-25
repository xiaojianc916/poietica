import type { BrowserSettingsPatch } from './capability'
import type { AgentCapability } from './model'

/* 能力就绪与安装、浏览器控制设置，都以 agent 报的那份为唯一事实源；连接生命周期由原生适配器处理。 */
export interface CapabilityGateway {
  readCapabilities(): Promise<readonly AgentCapability[]>
  /** 跟随已有后台任务，必要时启动安装，并在落定后返回最终状态。 */
  installCapability(capabilityId: string): Promise<AgentCapability>
  /** agent 的浏览器控制设置。 */
  readBrowserSettings(): Promise<{ enabled: boolean; headless: boolean; cdpUrl: string | null }>
  /** 本机内置浏览器的 CDP 端点；非 Windows 或未分配端口时为 null。 */
  readAppBrowserEndpoint(): Promise<string | null>
  /** 写浏览器控制设置；缺席的格不改，交回写完的整份。 */
  writeBrowserSettings(patch: BrowserSettingsPatch): Promise<{
    enabled: boolean
    headless: boolean
    cdpUrl: string | null
  }>
}
