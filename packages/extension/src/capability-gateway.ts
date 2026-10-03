import type { BrowserSettingsPatch } from './capability'
import type { AgentCapability } from './model'

/* 能力就绪与安装、浏览器控制设置，都以 agent 报的那份为唯一事实源；连接生命周期由原生适配器处理。 */
export interface CapabilityGateway {
  readCapabilities(): Promise<readonly AgentCapability[]>
  /**
   * 开关一项能力，交回改完之后的**整份**清单。
   *
   * 交整份而不是被点的那一项：agent 里这一项没有「安装」这一步（桌面控制是它构建期
   * 编进来的 eval 前奏），一次开关改的是一个设置，而清单里别的项也可能跟着变。
   */
  installCapability(capabilityId: string, enabled: boolean): Promise<readonly AgentCapability[]>
  /** agent 的浏览器控制设置。 */
  readBrowserSettings(): Promise<{
    enabled: boolean
    headless: boolean
    relay: boolean
    cdpUrl: string | null
  }>
  /** 写浏览器控制设置；缺席的格不改，交回写完的整份。 */
  writeBrowserSettings(patch: BrowserSettingsPatch): Promise<{
    enabled: boolean
    headless: boolean
    relay: boolean
    cdpUrl: string | null
  }>
}
