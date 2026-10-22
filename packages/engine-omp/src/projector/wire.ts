/*
 * omp 载荷的结构收窄：子代理帧、后台作业快照与子代理通道都按结构读，认不出的格当缺席。
 * projector 与 session 两处共用这一份，免得同一判据写两遍后各自漂移。
 */

export function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}
