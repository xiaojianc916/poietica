import { describe, expect, test } from 'bun:test'
import type { AgentSkill, SkillRecord } from './model'
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

  test('projects one native snapshot without a renderer-side merge', () => {
    const native: AgentSkill = {
      id: 'skill:review',
      name: 'review',
      description: 'Review changed code',
      source: 'project',
      path: '/work/poietica/.kimi-code/skills/review/SKILL.md',
      project: 'poietica',
      projectPath: '/work/poietica',
      document: record.document,
      directory: null,
      enabled: true,
      loaded: true,
      kind: 'flow',
      disableModelInvocation: true,
      supportingFiles: 2,
      totalBytes: 3200,
      modifiedAt: 1_700_000_000,
    }

    expect(skillRows([native])).toEqual([
      expect.objectContaining({
        key: 'skill:review',
        project: 'poietica',
        body: 'Inspect the diff.',
        loaded: true,
      }),
    ])
  })
})
