import type { AutomationDraft } from './automation'

export interface AutomationTemplate {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly prompt: string
  readonly schedule: string | null
}

export function draftOfTemplate(
  template: AutomationTemplate,
  context: Pick<AutomationDraft, 'workspaceRoot' | 'timeZone'>,
): AutomationDraft {
  return {
    title: template.title,
    prompt: template.prompt,
    schedule: template.schedule,
    sessionConfig: {},
    ...context,
  }
}

/*
 * description 是卡片上那两行灰字，超出部分由 line-clamp-2 截掉，所以写完整句。
 * prompt 是真正投给 agent 的正文：与 description 同一件事，但说清边界与产出形态。
 */
export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = [
  {
    id: 'morning-briefing',
    title: '晨会动态',
    description:
      '汇总上一个工作日以来的提交、模块变化、CI 状态和待跟进事项，最终生成不超过 6 条的晨会口述摘要。只读分析，只使用已有数据，不修改任何文件',
    prompt:
      '汇总上一个工作日以来的进展：提交、模块变化、CI 状态、待跟进事项。最终给出一条不超过 6 条的晨会口述摘要，每条一句话，按重要性排序。只读分析，不改任何文件，也不要提交',
    schedule: '0 9 * * 1-5',
  },
  {
    id: 'risk-scan',
    title: '风险扫描',
    description:
      '检查最近 24 小时的代码变更，识别运行错误、数据丢失、权限绕过、资源泄漏及跨端兼容等高危风险，并附代码和复现路径',
    prompt:
      '检查最近 24 小时的代码变更，识别运行错误、数据丢失、权限绕过、资源泄漏、跨端兼容等高风险问题。每一条给出文件与行号、触发条件、以及最小复现路径。没有就直接说没有，不要为凑数报低危项',
    schedule: '0 10 * * *',
  },
  {
    id: 'release-notes',
    title: '发布简报',
    description:
      '整理本周合并的 PR 和 commit，按功能、修复、体验及工程改进分类，同时生成团队版和面向用户的精简发布说明。只读不改代码',
    prompt:
      '整理本周合并的 PR 与 commit，按功能、修复、体验、工程改进四类归纳。产出两份：一份给团队的内部简报（含 PR 编号），一份面向用户的精简发布说明（只讲用户能感知的变化）。只读，不改代码',
    schedule: '0 16 * * 5',
  },
  {
    id: 'docs-sync',
    title: '文档同步检查',
    description:
      '对照最近 7 天的代码、配置、接口与文档变更，识别已改变公开行为但文档尚未同步的高置信差异，并附文件路径和修改建议',
    prompt:
      '对照最近 7 天的代码、配置、接口与文档变更，找出已经改变对外行为、但文档还停在旧说法的位置。只报高置信差异，每条附文件路径与建议改法。以代码为准，不要相信注释',
    schedule: '0 15 * * 3',
  },
]
