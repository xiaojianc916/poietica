/* Domain-owned vocabulary. The native bridge translates generated wire DTOs at the process boundary. */
export type UpdateKind = 'patch' | 'full'
export type UpdateProgress = { percent: number | null }
export type UpdateRelease = { version: string; notes: string | null; kind: UpdateKind }
