import { commands } from '@poietica/contract'
import type { CapabilityGateway, ExtensionGateway } from '@poietica/extension'
import { resolveLauncher } from '../agent/launcher'
import { throughIpc } from '../ipc-error'

/*
 * 扩展与技能账本的 IPC 实现：实现 @poietica/extension 的 ExtensionGateway 端口，
 * 由组合根注入 store。DTO 一个字都不在这里声明 —— 原生侧是契约的产地，这一层只
 * 把它转成 Promise 并让失败走同一条 throughIpc。
 *
 * 插件与技能的每次写都先落 agent 会读的那个文件，写成了才回话 —— 没有「界面已经
 * 变了、agent 那边还没变」的窗口。
 */

export const extensionGateway: ExtensionGateway = {
  listPlugins: () => throughIpc(() => commands.pluginsList()),

  stagePlugin: (fetch) => throughIpc(() => commands.pluginsStage(fetch)),

  commitPlugin: (request) =>
    throughIpc(async () => {
      await commands.pluginsCommit(request)
    }),

  discardStagedPlugin: (stagingId) =>
    throughIpc(async () => {
      await commands.pluginsDiscard(stagingId)
    }),

  removePlugin: (pluginId) =>
    throughIpc(async () => {
      await commands.pluginsRemove(pluginId)
    }),

  setPluginEnabled: (pluginId, enabled) =>
    throughIpc(async () => {
      await commands.pluginsSetEnabled(pluginId, enabled)
    }),

  setPluginMcpEnabled: (pluginId, server, enabled) =>
    throughIpc(async () => {
      await commands.pluginsSetMcpEnabled(pluginId, server, enabled)
    }),

  /* 上一次拉下来、存在盘上那一份。null 表示从来没取过。 */
  readPluginCatalog: () => throughIpc(() => commands.pluginsCatalogRead()),

  refreshPluginCatalog: (url) => throughIpc(() => commands.pluginsCatalogRefresh(url)),

  /*
   * 用户自己那个家里的那本账 —— 只读。
   *
   * null 表示这台机器上没有第二本账：受控 home 没有生效时，CLI 与我们读的是同一个
   * 文件。空数组表示那本账在，里面一个插件都没有。
   */
  listForeignPlugins: () => throughIpc(() => commands.pluginsForeignList()),

  /* 本机 skills/ 里装着哪些：一行一个目录，带启用状态与 SKILL.md 原文。 */
  listSkills: () => throughIpc(async () => commands.skillsList()),

  stageSkill: (fetch) => throughIpc(() => commands.skillsStage(fetch)),

  commitSkill: (request) =>
    throughIpc(async () => {
      await commands.skillsCommit(request)
    }),

  discardStagedSkill: (stagingId) =>
    throughIpc(async () => {
      await commands.skillsDiscard(stagingId)
    }),

  trashSkill: (name) =>
    throughIpc(async () => {
      await commands.skillsTrash(name)
    }),

  /* 停用与启用：原生侧在 SKILL.md 与 SKILL.md.disabled 之间改名。 */
  setSkillEnabled: (name, enabled) =>
    throughIpc(async () => {
      await commands.skillsSetEnabled(name, enabled)
    }),

  /*
   * 这个 agent 自己那份 mcp.json。路径由原生侧算，这一层不拼也不猜。
   */
  readEnvironmentMcpConfig: () => throughIpc(() => commands.environmentMcpConfig()),

  /*
   * expectedContents 是这次读—改—写开始时读到的原文（文件不存在时是 null），原生侧
   * 比不上就拒绝，两个并发写者谁也抹不掉谁；不受控时一律拒绝 —— 那份文件是用户终端
   * 里的那套服务器，不归本应用写。
   */
  writeEnvironmentMcpConfig: (expectedContents, contents) =>
    throughIpc(() => commands.environmentMcpConfigWrite(expectedContents, contents)),

  /* stdio 启动器在不在，见 launcher.ts。McpLauncher 与领域的 Launcher 同形。 */
  resolveLauncher,
}

/*
 * 本机能力账本这一路：读一次清单，或者开关一项。
 *
 * `cwd` 是当前活动工作区：这几条问的都是与工作区无关的进程级事实，但它们都可能替
 * 整条进程起出第一条连接 —— 那一刻它就是锚（见 agent/models.ts 的同名说明）。
 */
export function createCapabilityGateway(cwd: () => string | null): CapabilityGateway {
  return {
    readCapabilities: () => throughIpc(() => commands.agentCapabilityReport({ cwd: cwd() })),
    installCapability: (capabilityId, enabled) =>
      throughIpc(() => commands.agentCapabilityInstall({ cwd: cwd(), capabilityId, enabled })),
    readBrowserSettings: () => throughIpc(() => commands.agentBrowserSettings({ cwd: cwd() })),
    writeBrowserSettings: (patch) =>
      throughIpc(() =>
        commands.agentSetBrowserSettings({
          cwd: cwd(),
          /* 缺席的格发 null：生成的契约是可空必填（serde Option 的投影）。 */
          enabled: patch.enabled ?? null,
          headless: patch.headless ?? null,
          relay: patch.relay ?? null,
          cdpUrl: patch.cdpUrl ?? null,
        }),
      ),
  }
}
