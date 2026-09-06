/**
 * 轨道几何：一格多高、一格在哪、指针多远还算数。鱼眼与预览卡都读这一处。
 *
 * 步距必须是 4 的倍数。Windows 显示缩放是 25% 的整数倍，1 CSS px = k/4 个设备
 * 像素；12 × k/4 恒为整数，所有格子因此共用同一个亚像素相位，粗细才看得一致。
 */
export const RAIL_PITCH_PX = 12
/** 超过这么多轮，轨道自己滚动；不到就整条铺开。 */
export const RAIL_VISIBLE_TURNS = 12
/** 高斯半宽：两个步距。波峰因此覆盖上下各两三根。 */
const FALLOFF_PX = RAIL_PITCH_PX * 2
/** 三个半宽之外权重已低于千分之二，与静止无异，不参与计算。 */
export const RAIL_REACH_PX = FALLOFF_PX * 3
/** 第 index 格的中线，在轨道自身的坐标里。算出来的，不问布局。 */
export function railCentre(index: number): number {
  return index * RAIL_PITCH_PX + RAIL_PITCH_PX / 2
}
/** 到落点 distance 像素处的权重，0..1 的高斯衰减。 */
export function railWeight(distance: number): number {
  const ratio = distance / FALLOFF_PX
  return Math.exp(-(ratio * ratio))
}
/** 落点邻域的闭区间；to < from 表示空。中心是等差数列，解不等式一步得到。 */
export function railWindow(
  anchor: number,
  count: number,
): { readonly from: number; readonly to: number } {
  const half = RAIL_PITCH_PX / 2
  return {
    from: Math.max(0, Math.ceil((anchor - RAIL_REACH_PX - half) / RAIL_PITCH_PX)),
    to: Math.min(count - 1, Math.floor((anchor + RAIL_REACH_PX - half) / RAIL_PITCH_PX)),
  }
}
