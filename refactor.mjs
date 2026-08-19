#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

const root = process.cwd()

function count(text, needle) {
  return text.split(needle).length - 1
}

function replaceOnce(text, before, after, label) {
  const completed = count(text, after)

  if (completed === 1) {
    return text
  }

  if (completed > 1) {
    throw new Error(`${label}: completed anchor is ambiguous (${completed} matches)`)
  }

  const matches = count(text, before)

  if (matches === 1) {
    return text.replace(before, after)
  }

  throw new Error(`${label}: expected exactly one source anchor, found ${matches}`)
}

const edits = [
  {
    path: 'packages/agent/src/session/permission-posture.ts',
    transform(text) {
      return replaceOnce(
        text,
        "    value: 'default',\n    title: '请求批准',",
        "    value: 'manual',\n    title: '请求批准',",
        'permission posture protocol id',
      )
    },
  },
  {
    path: 'packages/agent-ui/src/composer/permission-picker.tsx',
    transform(text) {
      let next = replaceOnce(
        text,
        ' * default（请求批准）、yolo（帮我批准）、auto（完全访问权限）。',
        ' * manual（请求批准）、yolo（帮我批准）、auto（完全访问权限）。',
        'permission picker documentation',
      )

      next = replaceOnce(
        next,
        '  auto: ShieldAlert,\n  default: Hand,\n  yolo: ShieldCheck,',
        '  auto: ShieldAlert,\n  manual: Hand,\n  yolo: ShieldCheck,',
        'permission picker glyph map',
      )

      next = replaceOnce(
        next,
        `  const current = permissionPostureOf(control.current)
  const Mark = glyphOf(control.current)

  /*
   * 认不得的档位显示 agent 自己的说法。
   *
   * 宁可露出一个英文名，也不能拿一个我们编的中文名去盖住一个我们没定义过的档位
   * —— 与 permission-dock 的 labelFor 同一条规矩。
   */
  const label =
    current?.pill ??
    control.choices.find((choice) => choice.value === control.current)?.label ??
    control.current`,
        `  const current = permissionPostureOf(control.current)

  /* Plan 等非批准模式归 ComposerModeChip；两者互斥，工具条只显示一个当前模式。 */
  if (current === undefined) {
    return null
  }

  const Mark = glyphOf(control.current)`,
        'permission picker ownership',
      )

      next = replaceOnce(
        next,
        "        data-alert={current?.alerts === true ? 'true' : undefined}",
        "        data-alert={current.alerts ? 'true' : undefined}",
        'permission picker alert state',
      )

      return replaceOnce(
        next,
        '<span className="assistant-posture__label">{label}</span>',
        '<span className="assistant-posture__label">{current.pill}</span>',
        'permission picker label',
      )
    },
  },
  {
    path: 'packages/agent-ui/src/composer/composer-actions.tsx',
    transform(text) {
      let next = replaceOnce(
        text,
        "import type { PaletteEntry, SessionConfigControl } from '@poietica/agent-contract'",
        "import { permissionPostureOf } from '@poietica/agent'\nimport type { PaletteEntry, SessionConfigControl } from '@poietica/agent-contract'",
        'composer action imports',
      )

      next = replaceOnce(
        next,
        ` * 档位那几组不是本文件编出来的：它们是 agent 报的 mode / other 两类选择器
 * （ACP session config options）。agent 没报就没有那一组 —— 画一行点不动的灰字
 * 等于告诉用户"这里坏了"。`,
        ` * 面板只承载不属于批准方式的 mode（目前是 Plan）与 other 选择器。批准方式
 * 由 PermissionPicker 独占，不能再把 Auto / YOLO 作为第二套入口重复显示。`,
        'composer palette ownership comment',
      )

      next = replaceOnce(
        next,
        `  for (const control of controls) {
    if (control.purpose !== 'mode' && control.purpose !== 'other') {
      continue
    }

    groups.push({
      id: control.id,
      heading: control.label,
      rows: control.choices.map(`,
        `  for (const control of controls) {
    if (control.purpose !== 'mode' && control.purpose !== 'other') {
      continue
    }

    const choices =
      control.purpose === 'mode'
        ? control.choices.filter((choice) => permissionPostureOf(choice.value) === undefined)
        : control.choices

    if (choices.length === 0) {
      continue
    }

    groups.push({
      id: control.id,
      heading: control.label,
      rows: choices.map(`,
        'composer palette permission filter',
      )

      next = replaceOnce(
        next,
        ` * 生效档位的胶囊，站在批准方式旁边。
 *
 * 首档是 agent 摆在最前的常态档（ACP 规定 options 的顺序就是渲染顺序），所以停在
 * 首档时这里什么都不画 —— 常态不需要标记。摘掉就是切回首档，与面板里点那一行走
 * 同一条写入路径。`,
        ` * 批准方式之外的生效模式。
 *
 * manual / yolo / auto 由 PermissionPicker 唯一显示；这里只显示 Plan 等额外模式。
 * 摘掉就是切回首档，与面板里点那一行走同一条写入路径。`,
        'mode chip ownership comment',
      )

      return replaceOnce(
        next,
        `  if (mode === undefined) {
    return null
  }`,
        `  if (mode === undefined || permissionPostureOf(mode.current) !== undefined) {
    return null
  }`,
        'mode chip permission guard',
      )
    },
  },
]

const additions = [
  {
    path: 'packages/agent/src/session/__tests__/permission-posture.test.ts',
    content: `import type { SessionConfigControl } from '@poietica/agent-contract'
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
`,
  },
  {
    path: 'packages/agent-ui/src/__tests__/composer-permission-projection.test.tsx',
    content: `import type { SessionConfigControl } from '@poietica/agent-contract'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ComposerModeChip, composerPaletteGroups } from '../composer/composer-actions'

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

function withCurrent(current: string): SessionConfigControl {
  return { ...MODE, current }
}

describe('批准方式的单一入口', () => {
  it('加号面板不再重复显示 Default、Auto 与 YOLO', () => {
    const groups = composerPaletteGroups({
      controls: [MODE],
      onSelectControl: () => undefined,
      palette: [],
    })

    expect(groups).toHaveLength(1)
    expect(groups[0]?.rows.map((row) => row.label)).toEqual(['Plan'])
  })

  it('额外模式胶囊不再重复显示 Auto 与 YOLO', () => {
    const render = (current: string) =>
      renderToStaticMarkup(
        <ComposerModeChip controls={[withCurrent(current)]} onSelect={() => undefined} />,
      )

    expect(render('manual')).toBe('')
    expect(render('auto')).toBe('')
    expect(render('yolo')).toBe('')
    expect(render('plan')).toContain('Plan')
  })
})
`,
  },
]

async function load(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') {
      throw new Error(`Required file does not exist: ${path}`)
    }
    throw cause
  }
}

const planned = []

for (const edit of edits) {
  const path = resolve(root, edit.path)
  const current = await load(path)
  const next = edit.transform(current)

  if (next !== current) {
    planned.push({ path, content: next, status: 'updated' })
  }
}

for (const addition of additions) {
  const path = resolve(root, addition.path)

  try {
    const current = await readFile(path, 'utf8')
    if (current !== addition.content) {
      throw new Error(`Refusing to overwrite non-matching file: ${addition.path}`)
    }
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') {
      planned.push({ path, content: addition.content, status: 'created' })
      continue
    }
    throw cause
  }
}

if (planned.length === 0) {
  console.log('Permission posture refactor already applied.')
  process.exit(0)
}

const staged = []

try {
  for (const change of planned) {
    await mkdir(dirname(change.path), { recursive: true })
    const temporary = `${change.path}.refactor-${process.pid}`
    await writeFile(temporary, change.content, 'utf8')
    staged.push({ ...change, temporary })
  }

  for (const change of staged) {
    await rename(change.temporary, change.path)
    console.log(`${change.status}: ${change.path.slice(root.length + 1)}`)
  }
} catch (cause) {
  await Promise.all(staged.map((change) => rm(change.temporary, { force: true })))
  throw cause
}
