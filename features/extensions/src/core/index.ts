import { defineCoreModule } from '@poietica/core-kernel'
import { platformContract } from '@poietica/feature-platform/contract'
import { WorkspacesServiceToken } from '@poietica/feature-workspaces/core-api'
import { AppError, isAppError, SystemErrorCode } from '@poietica/foundation'
import { extensionsContract, extensionsErrors } from '../contract'

/*
 * 引擎把「目录 / zip 里没有 SKILL.md」与「没有这个插件」都报成内核级的通用码
 * （`kernel.invalid_params` / `kernel.not_found`），而 extensions 的契约对这两件事各有一枚
 * 自己的码（07 页 §8B：`invalid_skill_package` / `plugin_not_found`）。
 *
 * 翻译放在**调用处**而不是芯片层：引擎端口是全应用共用的（04 页），那里报通用码是对的；
 * 「这件事属于哪一类产品错误」只有各功能的契约知道。07 页 §10C 的 git 错误码转换同此形制。
 */
function translateInstallError(e: unknown): never {
  if (isAppError(e) && e.code === SystemErrorCode.invalidParams) {
    throw new AppError(extensionsErrors.invalid_skill_package, '目录或 zip 中没有 SKILL.md')
  }
  throw e
}

function translatePluginError(e: unknown): never {
  if (isAppError(e) && e.code === SystemErrorCode.notFound) {
    throw new AppError(extensionsErrors.plugin_not_found, '插件不存在')
  }
  throw e
}

export default defineCoreModule({
  id: 'extensions',
  contract: extensionsContract,
  dependsOn: ['workspaces'],
  setup(ctx) {
    const { engine } = ctx
    const workspaces = ctx.services.get(WorkspacesServiceToken)

    const emitSkillsChanged = (): void => {
      ctx.rpc.emit('skills.changed', {})
    }
    const emitPluginsChanged = (): void => {
      ctx.rpc.emit('plugins.changed', {})
    }

    ctx.disposables.add(
      engine.mcp.onDidChangeStatus((statuses) => {
        ctx.rpc.emit('mcp.statusChanged', { servers: statuses })
      }),
    )

    // ---- skills ----

    ctx.rpc.handle('skills.list', async (p) => {
      const cwd = p.workspaceId === undefined ? null : workspaces.requireUsable(p.workspaceId).path
      const skills = await engine.skills.list(cwd)
      return { skills }
    })

    ctx.rpc.handle('skills.setEnabled', async (p) => {
      await engine.skills.setEnabled(p.skillId, p.enabled)
      emitSkillsChanged()
      return {}
    })

    ctx.rpc.handle('skills.install', async (p) => {
      const skill = await (p.source.kind === 'directory'
        ? engine.skills.installFromDirectory(p.source.path)
        : engine.skills.installFromZip(p.source.path)
      ).catch(translateInstallError)
      emitSkillsChanged()
      return skill
    })

    ctx.rpc.handle('skills.remove', async (p) => {
      const all = await engine.skills.list(null)
      const skill = all.find((s) => s.id === p.skillId)
      if (skill === undefined) {
        throw new AppError(extensionsErrors.skill_not_found, '技能不存在')
      }
      if (skill.source !== 'user') {
        throw new AppError(extensionsErrors.skill_not_removable, '内置或项目技能不能删除')
      }
      await ctx.host.call(platformContract, 'shell.trashItem', { path: skill.path })
      await engine.skills.forget(p.skillId)
      emitSkillsChanged()
      return {}
    })

    ctx.rpc.handle('skills.read', async (p) => {
      return engine.skills.read(p.skillId)
    })

    // ---- mcp ----

    ctx.rpc.handle('mcp.list', async () => {
      const servers = await engine.mcp.list()
      return { servers }
    })

    ctx.rpc.handle('mcp.upsert', async (p) => {
      /*
       * 按名字 upsert（幂等）。**mcp_name_conflict 在 Core 侧目前不可达**：05 页 §11 的参数只有
       * McpServerInfo，「新增」与「更新」在线上没有区分位，而「名字已存在」恰恰就是更新。
       * 见 docs/refactor-log.md 的待决问题 Q21；等契约补上意图位（或 UI 走独立的新增方法）再接。
       */
      await engine.mcp.upsert(p)
      return {}
    })

    ctx.rpc.handle('mcp.remove', async (p) => {
      await engine.mcp.remove(p.name)
      return {}
    })

    ctx.rpc.handle('mcp.status', async () => {
      const statuses = await engine.mcp.status()
      return { servers: statuses }
    })

    // ---- plugins ----

    ctx.rpc.handle('plugins.list', async () => {
      const plugins = await engine.plugins.list()
      return { plugins }
    })

    ctx.rpc.handle('plugins.marketplace', async (p) => {
      const entries = await engine.plugins.marketplace(p.query)
      return { entries }
    })

    ctx.rpc.handle('plugins.install', async (p) => {
      const plugin = await engine.plugins.install(p.pluginId)
      emitPluginsChanged()
      return plugin
    })

    ctx.rpc.handle('plugins.uninstall', async (p) => {
      await engine.plugins.uninstall(p.pluginId).catch(translatePluginError)
      emitPluginsChanged()
      return {}
    })

    ctx.rpc.handle('plugins.setEnabled', async (p) => {
      await engine.plugins.setEnabled(p.pluginId, p.enabled).catch(translatePluginError)
      emitPluginsChanged()
      return {}
    })
  },
})
