import { defineErrors } from '@poietica/contract-kit'

export const extensionsErrors = defineErrors('extensions', {
  skill_not_found: '技能不存在',
  skill_not_removable: '内置或项目技能不能删除',
  invalid_skill_package: '目录或 zip 中没有 SKILL.md',
  plugin_not_found: '插件不存在',
  mcp_name_conflict: 'MCP 服务器名称已存在',
})
