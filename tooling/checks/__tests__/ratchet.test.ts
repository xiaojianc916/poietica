import { describe, expect, test } from 'bun:test'
import { compare, countFile, emptyCounts } from '../ratchet'

describe('ratchet', () => {
  test('tracks omp deep imports without counting root imports', () => {
    expect(
      countFile("import x from '@oh-my-pi/pi-ai'\nimport y from '@oh-my-pi/pi-ai/internal'", 'packages/x/a.ts')[
        'omp-deep-import'
      ],
    ).toBe(1)
  })
  test('tracks English comparisons but not keyboard comparisons', () => {
    const result = countFile(
      "if (message === 'Approve now') {}\nif (event.key === 'Enter') {}",
      'features/x/src/ui/a.ts',
    )
    expect(result['english-ui-text']).toBe(1)
  })
  test('tracks unknown payload probes in UI', () => {
    const result = countFile(
      "import { bag } from '@poietica/view-kit'\nconst x = bag(value)\nconst y = value as Record<string, unknown>",
      'features/x/src/ui/a.ts',
    )
    expect(result['tool-payload-parsing']).toBe(2)
  })
  test('tracks platform branches', () => {
    expect(countFile("if (process.platform === 'win32') {}", 'packages/x/a.ts')['platform-branch']).toBe(2)
  })
  test('detects increases and decreases separately', () => {
    const base = emptyCounts(),
      current = emptyCounts()
    base['platform-branch']['x.ts'] = 2
    current['platform-branch']['x.ts'] = 1
    current['omp-deep-import']['y.ts'] = 1
    const result = compare(base, current)
    expect(result.grown).toHaveLength(1)
    expect(result.shrunk).toHaveLength(1)
  })
})
