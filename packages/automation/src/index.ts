export type {
  Automation,
  AutomationCatalog,
  AutomationRun,
  AutomationRunOutcome,
  SchedulePreview,
  ScheduleProblem,
} from '@poietica/contract/automation'
export {
  type AutomationDraft,
  activeRun,
  BLANK_DRAFT,
  type CommonScheduleKind,
  DEFAULT_SCHEDULE,
  DEFAULT_SCHEDULE_TIME,
  describeMoment,
  describeSchedule,
  draftOf,
  isTerminal,
  latestRun,
  RUN_LABELS,
  type ScheduleKind,
  sameSessionConfig,
  scheduleFor,
  scheduleKindOf,
  scheduleTimeOf,
  scheduleWeekdayOf,
  sessionConfigOf,
  summarize,
  WEEKDAY_LABELS,
  type Weekday,
} from './automation'
export type { AutomationGateway } from './automation-gateway'
export { type AutomationStore, createAutomationStore } from './automation-store'
export {
  AUTOMATION_TEMPLATES,
  type AutomationTemplate,
  draftOfTemplate,
} from './templates'
