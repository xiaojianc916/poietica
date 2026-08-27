import { describe, expect, test } from 'bun:test'
import { parseAgentDocument, serializeAgentDocument } from './agent-document'

describe('custom agent documents', () => {
  test('round‑trips the official fields', () => {
    const input = `---
name: reviewer
description: Reviews code
tools: [Read, Grep]
subagents: [explore]
---
Review carefully.
`
    const parsed = parseAgentDocument('reviewer.md', input)

    expect(parseAgentDocument('reviewer.md', serializeAgentDocument(parsed))).toMatchObject({
      name: 'reviewer',
      toolMode: 'allowlist',
      delegationMode: 'allowlist',
      prompt: 'Review carefully.',
    })
  })

  test('preserves unknown cross‑tool fields without pretending they work', () => {
    const input = `---
description: Reviews code
model: vendor/model
---
Review carefully.
`
    const parsed = parseAgentDocument('reviewer.md', input)
    expect(serializeAgentDocument(parsed)).toContain('model: vendor/model')
  })

  test('rejects names outside the Kimi schema', () => {
    const input = `---
description: Reviews code
---
Review carefully.
`
    expect(() => parseAgentDocument('Bad Name.md', input)).toThrow('kebab‑case')
  })
})
