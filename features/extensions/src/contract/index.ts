import { defineContract, defineMethod, defineNotification } from '@poietica/contract-kit'
import { MarketplaceEntry, McpServerInfo, McpStatus, PluginInfo, SkillInfo } from '@poietica/engine'
import { z } from 'zod'
import { SkillInstallSource } from './entities'
import { extensionsErrors } from './errors'

export * from './entities'
export { extensionsErrors } from './errors'

const empty = z.object({})

export const extensionsContract = defineContract({
  id: 'extensions',
  namespaces: ['skills', 'mcp', 'plugins'],
  methods: [
    defineMethod({
      name: 'skills.list',
      owner: 'core',
      params: z.object({ workspaceId: z.string().optional() }),
      result: z.object({ skills: z.array(SkillInfo) }),
      description: '列出技能（workspaceId 为 null 时按全局）',
    }),
    defineMethod({
      name: 'skills.setEnabled',
      owner: 'core',
      params: z.object({ skillId: z.string().min(1), enabled: z.boolean() }),
      result: empty,
      description: '启用/停用技能',
    }),
    defineMethod({
      name: 'skills.install',
      owner: 'core',
      params: z.object({ source: SkillInstallSource }),
      result: SkillInfo,
      timeoutMs: 300_000,
      description: '安装技能（目录或 zip）',
    }),
    defineMethod({
      name: 'skills.remove',
      owner: 'core',
      params: z.object({ skillId: z.string().min(1) }),
      result: empty,
      description: '删除技能（移到回收站）',
    }),
    defineMethod({
      name: 'skills.read',
      owner: 'core',
      params: z.object({ skillId: z.string().min(1) }),
      result: z.object({ markdown: z.string() }),
      description: '读技能的 SKILL.md',
    }),
    defineMethod({
      name: 'mcp.list',
      owner: 'core',
      params: empty,
      result: z.object({ servers: z.array(McpServerInfo) }),
      description: '列出 MCP 服务器',
    }),
    defineMethod({
      name: 'mcp.upsert',
      owner: 'core',
      params: McpServerInfo,
      result: empty,
      description: '新增或更新 MCP 服务器（新增时名字冲突 → mcp_name_conflict）',
    }),
    defineMethod({
      name: 'mcp.remove',
      owner: 'core',
      params: z.object({ name: z.string().min(1) }),
      result: empty,
      description: '删除 MCP 服务器',
    }),
    defineMethod({
      name: 'mcp.status',
      owner: 'core',
      params: empty,
      result: z.object({ servers: z.array(McpStatus) }),
      description: '查 MCP 服务器状态',
    }),
    defineMethod({
      name: 'plugins.list',
      owner: 'core',
      params: empty,
      result: z.object({ plugins: z.array(PluginInfo) }),
      description: '列出已安装插件',
    }),
    defineMethod({
      name: 'plugins.marketplace',
      owner: 'core',
      params: z.object({ query: z.string().nullable() }),
      result: z.object({ entries: z.array(MarketplaceEntry) }),
      description: '查 omp 市场',
    }),
    defineMethod({
      name: 'plugins.install',
      owner: 'core',
      params: z.object({ pluginId: z.string().min(1) }),
      result: PluginInfo,
      timeoutMs: 300_000,
      description: '安装插件',
    }),
    defineMethod({
      name: 'plugins.uninstall',
      owner: 'core',
      params: z.object({ pluginId: z.string().min(1) }),
      result: empty,
      description: '卸载插件',
    }),
    defineMethod({
      name: 'plugins.setEnabled',
      owner: 'core',
      params: z.object({ pluginId: z.string().min(1), enabled: z.boolean() }),
      result: empty,
      description: '启用/停用插件',
    }),
  ],
  notifications: [
    defineNotification({
      name: 'skills.changed',
      owner: 'core',
      params: empty,
      description: '技能列表变化',
    }),
    defineNotification({
      name: 'mcp.statusChanged',
      owner: 'core',
      params: z.object({ servers: z.array(McpStatus) }),
      description: 'MCP 状态变化',
    }),
    defineNotification({
      name: 'plugins.changed',
      owner: 'core',
      params: empty,
      description: '插件列表变化',
    }),
  ],
  errors: extensionsErrors,
})
