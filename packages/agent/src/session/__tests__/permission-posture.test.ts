import type { SessionConfigControl } from '@poietica/agent-contract'
import { describe, expect, it } from 'vitest'
import { permissionPostureOf, permissionPosturesOf } from '../permission-posture'

const MODE: SessionConfigControl = {
  id: 'mode',
  label: 'Mode',
  purpose: 'mode',
  current: 'manual',
  choices: [
    { value: 'manual', label: 'Default' },
    { value: 'plan', label: 'Plan' },
    { value: 'auto', label: 'Auto' },
    { value: 'yolo', label: 'YOLO' },
  ],
}

describe('批准方式投影', () => {
  it('使用 kap 的 manual 标识并只呈现三档产品文案', () => {
    expect(permissionPosturesOf(MODE).map((posture) => posture.value)).toEqual([
      'manual',
      'yolo',
      'auto',
    ])
    expect(permissionPostureOf('manual')).toMatchObject({
      title: '请求批准',
      pill: '请求批准',
    })
    expect(permissionPostureOf('plan')).toBeUndefined()
  })
})
