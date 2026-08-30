import type { AutomationDraft } from './automation'

/**
 * 模板画廊。
 *
 * 模板不是「预置的自动化」，它是一份草稿：添加之后落进列表，随时可改可删。
 * 分类是穷尽且互斥的，所以没有 Cursor 那种 Popular 页签 —— 那是一份人工挑选的
 * 子集，在一个只有六条内置模板的本地应用里，「精选」挑不出任何信息。
 */

export const AUTOMATION_CATEGORIES = ['代码审查', '安全', '测试', '文档'] as const

export type AutomationCategory = (typeof AUTOMATION_CATEGORIES)[number]

export interface AutomationTemplate {
  readonly id: string
  readonly category: AutomationCategory
  readonly title: string
  readonly description: string
  readonly prompt: string
  /** crontab 表达式；null 就是手动。 */
  readonly schedule: string | null
}

/**
 * 模板摊成一份草稿。
 *
 * 会话设置留空：模板对模型没有意见。空表在编辑器里的意思是「显示 agent 此刻
 * 报的组合」，人按下保存，存进去的就是屏幕上那三颗胶囊 —— 所以模板不必替人
 * 猜一个模型名，也不会因此多出「未选择」这个第三态。
 *
 * 这一步在这里做，不在画廊组件里做：画廊知道的只有「人点了哪一张卡」。
 */
export function draftOfTemplate(template: AutomationTemplate): AutomationDraft {
  return {
    title: template.title,
    prompt: template.prompt,
    schedule: template.schedule,
    sessionConfig: {},
  }
}

export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = [
  {
    id: 'critical-bugs',
    category: '代码审查',
    title: '找出关键缺陷',
    description: '审阅最近的提交，只报正确性层面的高危问题，并给出最小修复',
    prompt:
      '审阅最近一天的提交。只报正确性层面的高危缺陷：数据丢失、竞态、边界条件、错误吞掉。每一条给出文件与行号，以及一份最小改动的修复建议。没有就直接说没有',
    schedule: '0 9 * * *',
  },
  {
    id: 'review-diff',
    category: '代码审查',
    title: '审阅当前改动',
    description: '对工作区未提交的改动做一次结构性审阅，而不是逐行挑刺',
    prompt:
      '审阅工作区当前未提交的改动。先判断这次改动有没有引入新旧杂糅或兼容层，再看命名与分层是否与仓库既有约定一致，最后才是细节',
    schedule: null,
  },
  {
    id: 'dependency-audit',
    category: '安全',
    title: '依赖与许可证巡检',
    description: '每周一检查依赖的已知漏洞与许可证变化',
    prompt:
      '检查这个仓库的依赖：有没有新增的已知漏洞、有没有许可证发生变化、有没有版本没有钉死。逐条给出证据与处置建议',
    schedule: '0 10 * * 1',
  },
  {
    id: 'secret-scan',
    category: '安全',
    title: '密钥泄漏排查',
    description: '扫描仓库里可能被写进源码或配置的凭据',
    prompt: '扫描仓库中可能被写进源码、配置或提交历史的凭据与密钥。给出位置与处置步骤',
    schedule: null,
  },
  {
    id: 'test-coverage',
    category: '测试',
    title: '补齐高风险测试',
    description: '找出最近改动中缺少覆盖的高风险逻辑，补上测试',
    prompt:
      '找出最近改动里缺少测试覆盖的高风险逻辑（状态机、并发、错误路径、边界条件），为它们补上测试。只补真正有风险的部分，不为了数字而写测试',
    schedule: null,
  },
  {
    id: 'docs-drift',
    category: '文档',
    title: '文档与代码对账',
    description: '找出注释与文档中已经不再成立的说法',
    prompt:
      '把 docs 与 AGENTS.md 里的说法与当前源码逐条对账，找出已经不成立的描述。不要相信注释，以代码为准',
    schedule: '0 18 * * *',
  },
]
