import { describe, expect, test } from 'bun:test'
import { sharedAreaImportViolations } from '../conversation-shared-imports'

const FILE = 'features/conversation/src/ui/shared/tools/fixture.ts'

describe('conversation/shared 原始 import 闸门', () => {
  test('真实 TS import/export/dynamic import 离开 shared 到区域就拒绝，shared 内部路径放行', () => {
    const source = [
      "import type { TimelineState } from '../../timeline/timeline-contract'",
      "export { TimelineItem } from '../../timeline/timeline-contract'",
      "void import('../../timeline/timeline-contract')",
      "import type { TurnPage } from '../timeline/timeline-contract'",
    ].join('\n')

    const violations = sharedAreaImportViolations(source, FILE)
    expect(violations).toHaveLength(3)
    expect(violations.every((violation) => violation.includes('../../timeline/timeline-contract'))).toBe(true)
    expect(violations.some((violation) => violation.includes("'../timeline/"))).toBe(false)
  })

  test('注释和普通字符串不算 import', () => {
    const violations = sharedAreaImportViolations(
      '// import x from \'../../timeline/timeline-contract\'\nconst text = "../../timeline/timeline-contract"\n',
      FILE,
    )
    expect(violations).toEqual([])
  })
})
