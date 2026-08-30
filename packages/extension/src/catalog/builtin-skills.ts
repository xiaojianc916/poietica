import type { PluginInstallSource } from '../install-source'

/*
 * 内置技能名单（公开档）。
 *
 * 来源全部是 anthropics/skills 仓库 main 分支下的子目录 —— 官方维护、SKILL.md 已逐个
 * 核实存在。公开档的语义与内置 MCP 名单一致：卸载后卡片留在名单上，随时装得回来。
 */

export interface BuiltinSkill {
  readonly id: string
  readonly displayName: string
  readonly description: string
  readonly group: string
  readonly source: PluginInstallSource
}

function anthropicSkill(
  id: string,
  displayName: string,
  description: string,
  group: string,
): BuiltinSkill {
  return {
    id,
    displayName,
    description,
    group,
    source: {
      kind: 'github',
      owner: 'anthropics',
      repo: 'skills',
      ref: { kind: 'tree', ref: 'main' },
      subdirectory: `skills/${id}`,
    },
  }
}

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
  anthropicSkill('docx', 'Word 文档', '创建与编辑 .docx：样式、表格、批注、修订。', '文档'),
  anthropicSkill('pdf', 'PDF 处理', '读取、拆合、填表、生成 PDF。', '文档'),
  anthropicSkill('pptx', 'PowerPoint', '创建与修改 .pptx 演示文稿：版式、图表、母版。', '文档'),
  anthropicSkill('xlsx', 'Excel 电子表格', '创建与编辑 .xlsx：公式、格式、图表。', '数据'),
  anthropicSkill(
    'skill-creator',
    '技能创建器',
    '引导写出一个结构合规的新技能（SKILL.md）。',
    '工具',
  ),
  anthropicSkill(
    'mcp-builder',
    'MCP 构建器',
    '从零搭一台 MCP 服务器：协议、工具定义、测试。',
    '工具',
  ),
]
