import '../../__tests__/omp-home'

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import { noopLogger } from '@poietica/foundation'
import { testLayout } from '../../__tests__/omp-home'
import { OmpSkillsPort } from '../skills'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

/** 一份最小的技能目录：SKILL.md 带 frontmatter。 */
function writeSkill(dir: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    ['---', `name: ${name}`, `description: ${description}`, '---', '', `# ${name}`, ''].join('\n'),
    'utf8',
  )
}

function makePort(root: Settings): OmpSkillsPort {
  return new OmpSkillsPort({ root, ompAgentDir: testLayout.ompAgentDir, logger: noopLogger })
}

/** global 层是按点分路径嵌套的；disabledExtensions 是顶层一格。 */
function disabledOf(root: Settings): readonly string[] {
  const value = root.getGlobalSettings().disabledExtensions
  return Array.isArray(value) ? (value as string[]) : []
}

describe('SkillsPort', () => {
  test('installFromDirectory 把目录复制进 <ompAgentDir>/skills 并报出名字与说明', async () => {
    const root = Settings.isolated()
    const port = makePort(root)
    const source = path.join(tempDir('poietica-skill-src-'), 'demo-skill')
    writeSkill(source, 'demo-skill', '一份演示技能')
    const installed = await port.installFromDirectory(source)
    expect(installed.id).toBe('demo-skill')
    expect(installed.name).toBe('demo-skill')
    expect(installed.description).toBe('一份演示技能')
    expect(installed.source).toBe('user')
    expect(installed.enabled).toBe(true)
    expect(installed.path).toBe(path.join(testLayout.ompAgentDir, 'skills', 'demo-skill'))
    const read = await port.read('demo-skill')
    expect(read.markdown).toContain('# demo-skill')
  })

  test('installFromZip 解压、校验结构后再改名进技能目录', async () => {
    const root = Settings.isolated()
    const port = makePort(root)
    const staging = tempDir('poietica-zip-')
    const source = path.join(staging, 'zip-skill')
    writeSkill(source, 'zip-skill', '压缩包里的技能')
    const zipFile = path.join(staging, 'skill.zip')
    const archive = new Bun.Archive({
      'zip-skill/SKILL.md': new TextEncoder().encode(await Bun.file(path.join(source, 'SKILL.md')).text()),
    })
    await Bun.write(zipFile, await archive.bytes())
    const installed = await port.installFromZip(zipFile)
    expect(installed.id).toBe('zip-skill')
    expect(installed.description).toBe('压缩包里的技能')
  })

  test('installFromZip 对没有 SKILL.md 的压缩包如实报错', async () => {
    const root = Settings.isolated()
    const port = makePort(root)
    const staging = tempDir('poietica-zip-bad-')
    writeFileSync(path.join(staging, 'readme.txt'), 'nothing here', 'utf8')
    const zipFile = path.join(staging, 'bad.zip')
    const archive = new Bun.Archive({ 'readme.txt': new TextEncoder().encode('nothing here') })
    await Bun.write(zipFile, await archive.bytes())
    await expect(port.installFromZip(zipFile)).rejects.toThrow(/SKILL\.md/)
  })

  test('setEnabled 写 disabledExtensions 的 skill:<name>，forget 清掉它', async () => {
    const root = Settings.isolated()
    const port = makePort(root)
    await port.setEnabled('demo', false)
    expect(disabledOf(root)).toContain('skill:demo')
    await port.setEnabled('demo', true)
    expect(disabledOf(root)).not.toContain('skill:demo')
    await port.setEnabled('demo', false)
    await port.forget('demo')
    expect(disabledOf(root)).not.toContain('skill:demo')
  })

  test('read 对不存在的技能抛 kernel.not_found', async () => {
    const root = Settings.isolated()
    const port = makePort(root)
    await expect(port.read('definitely-not-installed')).rejects.toMatchObject({ code: 'kernel.not_found' })
  })
})
