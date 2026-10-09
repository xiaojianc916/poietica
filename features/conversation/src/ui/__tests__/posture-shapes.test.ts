import { describe, expect, test } from 'bun:test'
import type { Controls } from '@poietica/engine'
import { permissionPosturesOf } from '../configuration/permission-posture'
import { POSTURE_TO_CONTROL, postureOfControl, sessionConfigControlsOf } from '../control-shapes'

/*
 * 真实故障：输入框那一排**没有批准方式**（胶囊以及它那张菜单整颗不画）。
 *
 * 根因是两套词表对不上：`PermissionPicker` 与 `configuration/permission-posture.ts` 是逐字
 * 从 legacy 迁来的，认的是**产品值** manual / yolo / auto；而这里原先把引擎的
 * ask / auto-edit / full-access 原样交过去，交集为空 → 组件按「这家 agent 不提供批准方式」
 * 处置，返回 null。
 *
 * 这条用例把两个方向都钉住：正向（引擎 → 产品，画得出来）与反向（产品 → 引擎，发得出去）。
 */
const controls = (posture: Controls['posture']): Controls => ({
  model: { current: null, choices: [] },
  thinking: { current: null, choices: [] },
  posture,
  planMode: false,
  goal: null,
  available: { plan: true, goal: true },
  context: null,
})

describe('引擎 Posture 与产品 permission 控件值', () => {
  test('正向：三档 Posture 各自映射到产品值', () => {
    expect(POSTURE_TO_CONTROL.ask).toBe('manual')
    expect(POSTURE_TO_CONTROL['auto-edit']).toBe('yolo')
    expect(POSTURE_TO_CONTROL['full-access']).toBe('auto')
  })

  test('正向：换算出来的 permission 控件，产品词表认得出它的每一档', () => {
    for (const posture of ['ask', 'auto-edit', 'full-access'] as const) {
      const found = sessionConfigControlsOf(controls(posture)).find((c) => c.purpose === 'permission')
      expect(found).toBeDefined()
      /* 产品词表与它交集非空 —— 空交集就是「整颗不画」。 */
      expect(permissionPosturesOf(found!).length).toBe(3)
      /* 当前档位也在产品词表里（不然胶囊自己也画不出来）。 */
      expect(permissionPosturesOf(found!).some((p) => p.value === found!.current)).toBe(true)
    }
  })

  test('反向：产品值换回引擎 Posture（发回 Core 的必须是引擎值）', () => {
    expect(postureOfControl('manual')).toBe('ask')
    expect(postureOfControl('yolo')).toBe('auto-edit')
    expect(postureOfControl('auto')).toBe('full-access')
    /* 认不出的值不猜。 */
    expect(postureOfControl('plan')).toBeUndefined()
    expect(postureOfControl('ask')).toBeUndefined()
  })

  test('双向是同一个双射：来回换一遍回到原值', () => {
    for (const posture of ['ask', 'auto-edit', 'full-access'] as const) {
      expect(postureOfControl(POSTURE_TO_CONTROL[posture])).toBe(posture)
    }
  })
})
