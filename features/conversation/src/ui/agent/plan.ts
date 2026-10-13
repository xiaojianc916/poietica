import type { InteractionAnswer } from '@poietica/engine'

/** 取引擎契约那一支，不另立词表：两处各写一份，改一处必然漏一处。 */
export type PlanAnswer = Extract<InteractionAnswer, { kind: 'plan' }>
export type PlanDecision = PlanAnswer['decision']
