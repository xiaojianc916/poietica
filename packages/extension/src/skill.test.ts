import { describe, expect, test } from 'bun:test'
import type { SkillRecord } from '@poietica/contract'
import { readSkills, skillFrontmatter, skillRows } from './skill'

const record: SkillRecord = {
  name: 'review',
  enabled: true,
  document:
    '---\nname: review\ndescription: Review changed code\ntype: flow\nwhen_to_use: Before merging\ndisable_model_invocation: true\n---\nInspect the diff.',
  path: '/home/person/.kimi-code/skills/review',
  supportingFiles: 2,
  totalBytes: 3200,
  modifiedAt: 1_700_000_000,
}

describe('skill catalog projection', () => {
  test('decodes Kimi metadata aliases and body', () => {
    const parsed = skillFrontmatter(record.document)

    expect(parsed).toMatchObject({
      name: 'review',
      description: 'Review changed code',
      body: 'Inspect the diff.',
      type: 'flow',
      whenToUse: 'Before merging',
      disableModelInvocation: true,
      issues: [],
    })
  })

  test('keeps invalid managed skills visible with diagnostics', () => {
    const invalid = readSkills([{ ...record, document: 'No frontmatter' }])[0]

    expect(invalid?.name).toBe('review')
    expect(invalid?.issues).toContain('SKILL.md 缺少 YAML frontmatter。')
  })

  test('merges the managed install with the runtime roster without shadow state', () => {
    const installed = readSkills([record])
    const rows = skillRows(installed, [
      { name: 'review', description: 'Runtime description', source: 'user' },
      { name: 'builtin-helper', description: 'Built in', source: 'builtin' },
    ])

    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.name === 'review')).toMatchObject({
      directory: 'review',
      loaded: true,
      path: '/home/person/.kimi-code/skills/review',
    })
    expect(rows.find((row) => row.name === 'builtin-helper')).toMatchObject({
      directory: undefined,
      source: 'builtin',
    })
  })
})
