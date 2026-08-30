/*
 * 包的唯一入口。逐个具名导出，不用 export *：这样「对外承诺了什么」是这一份
 * 文件读得出来的事实，而不是一次通配符展开的副作用。
 */

export type { Automation } from '@poietica/contract'
export {
  type AutomationDraft,
  BLANK_DRAFT,
  DEFAULT_SCHEDULE,
  describeMoment,
  describeSchedule,
  draftOf,
  latestRun,
  nextRunAfter,
  SCHEDULE_PRESETS,
  type ScheduleProblem,
  sameSessionConfig,
  scheduleProblem,
  sessionConfigOf,
  summarize,
} from './automation'
export type { AutomationGateway } from './automation-gateway'
export type { AutomationDispatch } from './automation-store'
export { type AutomationStore, createAutomationStore } from './automation-store'
export {
  AUTOMATION_CATEGORIES,
  AUTOMATION_TEMPLATES,
  type AutomationCategory,
  type AutomationTemplate,
  draftOfTemplate,
} from './templates'
