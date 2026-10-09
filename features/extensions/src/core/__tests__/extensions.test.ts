import { describe, expect, test } from 'bun:test'
import { createCoreHarness } from '@poietica/core-kernel/testing'
import { createFakeEngine } from '@poietica/engine-testkit'
import workspaces from '@poietica/feature-workspaces/core'
import { AppError, SystemErrorCode } from '@poietica/foundation'
import { extensionsContract } from '../../contract'
import extensions from '../index'

type SkillRow = {
  id: string
  name: string
  description: string
  source: 'builtin' | 'user' | 'project'
  enabled: boolean
  path: string
}

/** 一个已安装的用户技能 */
const USER_SKILL: SkillRow = {
  id: '/skills/mine',
  name: 'mine',
  description: '',
  source: 'user',
  enabled: true,
  path: 'D:/skills/mine',
}

const BUILTIN_SKILL: SkillRow = {
  id: 'builtin-1',
  name: '内置技能',
  description: '',
  source: 'builtin',
  enabled: true,
  path: 'D:/app/skills/builtin-1',
}

describe('extensions core', () => {
  /*
   * U10（07 页 §8B/§8C）：引擎把「没有 SKILL.md」报成内核级的 kernel.invalid_params，
   * 而契约对这件事有自己的一枚码。翻译必须发生在 extensions 的 Core 里 —— 否则
   * `extensions.invalid_skill_package` 全仓没有抛点，契约承诺的错误码不可达。
   */
  test('装一个没有 SKILL.md 的 zip → extensions.invalid_skill_package（不是 kernel.invalid_params）', async () => {
    const base = createFakeEngine()
    const engine = {
      ...base,
      skills: {
        ...base.skills,
        installFromZip: async () => {
          throw new AppError(SystemErrorCode.invalidParams, '压缩包里没有 SKILL.md')
        },
      },
    }
    const h = await createCoreHarness({ modules: [workspaces, extensions], engine: engine as never })
    const api = h.client(extensionsContract)
    const err = await api.call('skills.install', { source: { kind: 'zip', path: 'D:/x.zip' } }).catch((e: unknown) => e)
    expect((err as AppError).code).toBe('extensions.invalid_skill_package')
    await h.dispose()
  })

  test('卸载没装过的插件 → extensions.plugin_not_found（不是 kernel.not_found）', async () => {
    const base = createFakeEngine()
    const engine = {
      ...base,
      plugins: {
        ...base.plugins,
        uninstall: async () => {
          throw new AppError(SystemErrorCode.notFound, '没有这个插件：x@y')
        },
      },
    }
    const h = await createCoreHarness({ modules: [workspaces, extensions], engine: engine as never })
    const api = h.client(extensionsContract)
    const err = await api.call('plugins.uninstall', { pluginId: 'x@y' }).catch((e: unknown) => e)
    expect((err as AppError).code).toBe('extensions.plugin_not_found')
    await h.dispose()
  })

  test('翻译只认那一枚码：引擎报别的错照样原样透传（不吞真原因）', async () => {
    const base = createFakeEngine()
    const engine = {
      ...base,
      plugins: {
        ...base.plugins,
        setEnabled: async () => {
          throw new AppError(SystemErrorCode.internal, '别处的故障')
        },
      },
    }
    const h = await createCoreHarness({ modules: [workspaces, extensions], engine: engine as never })
    const api = h.client(extensionsContract)
    const err = await api.call('plugins.setEnabled', { pluginId: 'x', enabled: true }).catch((e: unknown) => e)
    expect((err as AppError).code).toBe('kernel.internal')
    await h.dispose()
  })

  test('删除用户技能：先调 shell.trashItem，再让引擎 forget', async () => {
    const trashed: string[] = []
    const forgotten: string[] = []
    const base = createFakeEngine()
    const engine = {
      ...base,
      skills: {
        ...base.skills,
        list: async () => [USER_SKILL],
        forget: async (id: string) => {
          forgotten.push(id)
        },
      },
    }
    const h = await createCoreHarness({
      modules: [workspaces, extensions],
      engine: engine as never,
      hostHandlers: {
        'shell.trashItem': (params: unknown) => {
          trashed.push((params as { path: string }).path)
          return {}
        },
      },
    })
    const api = h.client(extensionsContract)
    await api.call('skills.remove', { skillId: USER_SKILL.id })

    expect(trashed).toEqual([USER_SKILL.path])
    expect(forgotten).toEqual([USER_SKILL.id])
    await h.dispose()
  })

  test('删除内置技能被拒（extensions.skill_not_removable），且不碰回收站', async () => {
    const trashed: string[] = []
    const base = createFakeEngine()
    const engine = { ...base, skills: { ...base.skills, list: async () => [BUILTIN_SKILL] } }
    const h = await createCoreHarness({
      modules: [workspaces, extensions],
      engine: engine as never,
      hostHandlers: {
        'shell.trashItem': (params: unknown) => {
          trashed.push((params as { path: string }).path)
          return {}
        },
      },
    })
    const api = h.client(extensionsContract)
    const err = await api.call('skills.remove', { skillId: BUILTIN_SKILL.id }).catch((e: unknown) => e)

    /* 铁律 5：跨边界的错误必须是 AppError，错误码是**码**而不是 message 里的一段文字 */
    expect((err as AppError).code).toBe('extensions.skill_not_removable')
    expect(trashed).toEqual([])
    await h.dispose()
  })

  test('shell.trashItem 失败时不 forget', async () => {
    const forgotten: string[] = []
    const base = createFakeEngine()
    const engine = {
      ...base,
      skills: {
        ...base.skills,
        list: async () => [USER_SKILL],
        forget: async (id: string) => {
          forgotten.push(id)
        },
      },
    }
    const h = await createCoreHarness({
      modules: [workspaces, extensions],
      engine: engine as never,
      hostHandlers: {
        'shell.trashItem': () => {
          throw new Error('platform.trash_failed')
        },
      },
    })
    const api = h.client(extensionsContract)
    await api.call('skills.remove', { skillId: USER_SKILL.id }).catch(() => undefined)

    expect(forgotten).toEqual([])
    await h.dispose()
  })

  /*
   * mcp.upsert 按名字幂等（第二次是更新，允许同名）。**mcp_name_conflict 目前不可达**：
   * 05 页 §11 的参数只有 McpServerInfo，没有区分新增/更新的位，而「名字已存在」就是更新。
   * 见 docs/refactor-log.md 待决问题 Q21。
   */
  test('同名的第二次 upsert 是更新（覆盖配置），不抛错', async () => {
    const base = createFakeEngine()
    const h = await createCoreHarness({ modules: [workspaces, extensions], engine: base })
    const api = h.client(extensionsContract)

    await api.call('mcp.upsert', { name: 'srv', transport: 'stdio', enabled: true, config: {} })
    await api.call('mcp.upsert', { name: 'srv', transport: 'stdio', enabled: true, config: { x: 1 } })

    const listed = await api.call('mcp.list', {})
    expect(listed.servers.length).toBe(1)
    expect(listed.servers[0]?.config).toEqual({ x: 1 })
    await h.dispose()
  })

  test('技能安装发 skills.changed', async () => {
    const base = createFakeEngine()
    const h = await createCoreHarness({ modules: [workspaces, extensions], engine: base })
    const api = h.client(extensionsContract)

    await api.call('skills.install', { source: { kind: 'directory', path: 'D:/skills/new' } })
    expect(h.notifications(extensionsContract, 'skills.changed').length).toBe(1)
    await h.dispose()
  })
})
