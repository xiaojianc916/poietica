/* 引擎与球体共用的两个数值微工具：钳位与均匀取样。 */

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : Math.min(v, b)
}

export function rand(a: number, b: number): number {
  return a + Math.random() * (b - a)
}
