import { describe, expect, test } from 'bun:test'
import { compare, countFile, emptyCounts } from '../ratchet'

describe('ratchet', () => {
  /* 每条规则的探针：只数该数的，根 import、键盘键名这类不算。 */
  test('四条规则各自的探针', () => {
    expect(
      countFile("import x from '@oh-my-pi/pi-ai'\nimport y from '@oh-my-pi/pi-ai/internal'", 'packages/x/a.ts')[
        'omp-deep-import'
      ],
    ).toBe(1)
    expect(
      countFile("if (message === 'Approve now') {}\nif (event.key === 'Enter') {}", 'features/x/src/ui/a.ts')[
        'english-ui-text'
      ],
    ).toBe(1)
    expect(
      countFile(
        "import { bag } from '@poietica/view-kit'\nconst x = bag(value)\nconst y = value as Record<string, unknown>",
        'features/x/src/ui/a.ts',
      )['tool-payload-parsing'],
    ).toBe(2)
    expect(countFile("if (process.platform === 'win32') {}", 'packages/x/a.ts')['platform-branch']).toBe(2)
  })

  test('变多与变少分开报：变多是失败，变少要求收紧基线', () => {
    const base = emptyCounts()
    const current = emptyCounts()
    base['platform-branch']['x.ts'] = 2
    current['platform-branch']['x.ts'] = 1
    current['omp-deep-import']['y.ts'] = 1
    const result = compare(base, current)
    expect(result.grown).toHaveLength(1)
    expect(result.shrunk).toHaveLength(1)
  })
})
