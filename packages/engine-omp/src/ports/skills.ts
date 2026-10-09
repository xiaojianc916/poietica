import { cp, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { discoverSkills } from '@oh-my-pi/pi-coding-agent'
import type { SkillInfo, SkillsPort } from '@poietica/engine'
import { AppError, type Logger, SystemErrorCode } from '@poietica/foundation'
import type { z } from 'zod'
import { toEngineError } from '../errors'
import { readSetting, type SettingsScope } from '../settings-access'
import { addArrayMember, flushOf, removeArrayMember } from './settings-writes'

/** 技能的启用状态住在 omp 的 disabledExtensions 里（`skill:<name>`）。 */
const DISABLED_EXTENSIONS = 'disabledExtensions'
/** 技能目录名：<ompAgentDir>/skills。 */
const SKILLS_DIR_NAME = 'skills'

/** SkillsPort 需要的东西：root 设置（启用状态）、omp 的 agent 目录、logger。 */
export interface SkillsPortDeps {
  readonly root: SettingsScope
  readonly ompAgentDir: string
  readonly logger: Logger
}

/**
 * 技能端口。发现走 omp 的 discoverSkills（它自己扫内置 / 用户 / 项目三处），
 * 安装就是把目录复制进 <ompAgentDir>/skills（zip 先解到临时目录、校验结构之后再改名）。
 * 启用状态写 omp 设置的 disabledExtensions（`skill:<name>`），不改技能文件本身。
 */
export class OmpSkillsPort implements SkillsPort {
  constructor(private readonly d: SkillsPortDeps) {}

  async list(cwd: string | null): Promise<z.infer<typeof SkillInfo>[]> {
    try {
      const found = await discoverSkills(cwd ?? process.cwd())
      const disabled = new Set(this.#disabledNames())
      return found.skills.map((skill) => ({
        id: skill.name,
        name: skill.name,
        description: skill.description,
        source: sourceOf(skill.source, skill._source?.level),
        enabled: !disabled.has(skill.name),
        path: skill.baseDir,
      }))
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** 开关：禁用写 `skill:<name>` 进 disabledExtensions，启用则把它拿掉。 */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    try {
      const key = `skill:${id}`
      if (enabled) removeArrayMember(this.d.root, DISABLED_EXTENSIONS, key)
      else addArrayMember(this.d.root, DISABLED_EXTENSIONS, key)
      await flushOf(this.d.root)
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** 安装一个目录：整份复制进 <ompAgentDir>/skills/<name>，校验它真是一份技能。 */
  async installFromDirectory(dir: string): Promise<z.infer<typeof SkillInfo>> {
    try {
      const name = path.basename(path.resolve(dir))
      const target = await this.#installInto(dir, name)
      return this.#infoOf(target, name)
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** 安装一个 zip：先解到临时目录、校验结构之后再改名进技能目录。 */
  async installFromZip(zipFile: string): Promise<z.infer<typeof SkillInfo>> {
    try {
      const staging = await mkdtemp(path.join(tmpdir(), 'poietica-skill-'))
      try {
        await extractZip(zipFile, staging)
        const root = await skillRootIn(staging)
        const name = path.basename(root)
        const target = await this.#installInto(root, name)
        return this.#infoOf(target, name)
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** 只清理 omp 设置里这个技能的启用状态；技能目录由 extensions 经 Host 的 shell.trashItem 移走。 */
  async forget(id: string): Promise<void> {
    try {
      removeArrayMember(this.d.root, DISABLED_EXTENSIONS, `skill:${id}`)
      await flushOf(this.d.root)
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** 技能正文：SKILL.md 原文（omp 侧没有「渲染好」的另一份）。 */
  async read(id: string): Promise<{ markdown: string }> {
    try {
      const found = await discoverSkills(process.cwd())
      const skill = found.skills.find((item) => item.name === id)
      if (skill === undefined) {
        throw new AppError(SystemErrorCode.notFound, `没有这个技能：${id}`)
      }
      return { markdown: await readFile(skill.filePath, 'utf8') }
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** 复制进技能目录：同名先挪走旧的，成功后再删 —— 中途失败不会既没旧的也没新的。 */
  async #installInto(source: string, name: string): Promise<string> {
    const base = path.join(this.d.ompAgentDir, SKILLS_DIR_NAME)
    await mkdir(base, { recursive: true })
    const target = path.join(base, name)
    const stale = `${target}.old-${Date.now().toString(36)}`
    let moved = false
    try {
      await rename(target, stale)
      moved = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      await cp(source, target, { recursive: true })
      if (moved) await rm(stale, { recursive: true, force: true })
    } catch (error) {
      if (moved) await rename(stale, target).catch(() => undefined)
      throw error
    }
    return target
  }

  /** 装完之后的一格：名字与说明从装好的目录现读，不抄一份。 */
  async #infoOf(target: string, fallbackName: string): Promise<z.infer<typeof SkillInfo>> {
    const markdown = await readFile(path.join(target, 'SKILL.md'), 'utf8').catch(() => '')
    return {
      id: fallbackName,
      name: frontmatterOf(markdown, 'name') ?? fallbackName,
      description: frontmatterOf(markdown, 'description') ?? '',
      source: 'user',
      enabled: !this.#disabledNames().includes(`skill:${fallbackName}`),
      path: target,
    }
  }

  #disabledNames(): readonly string[] {
    const value = readSetting(this.d.root, DISABLED_EXTENSIONS)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  }
}

/** omp 的 source 字符串 + _source.level → 契约的三档（认不出按用户级算，界面至少画得出来）。 */
function sourceOf(source: string, level: string | undefined): 'builtin' | 'user' | 'project' {
  if (level === 'project') return 'project'
  if (level === 'native' || source.includes('managed')) return 'builtin'
  return 'user'
}

/** 极简 frontmatter 取值：只认单行的 `key: value`，技能说明没有多行 YAML 的写法。 */
function frontmatterOf(markdown: string, key: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)
  const block = match?.[1]
  if (block === undefined) return undefined
  for (const line of block.split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    if (line.slice(0, at).trim() !== key) continue
    const value = line.slice(at + 1).trim()
    return value === '' ? undefined : value.replace(/^["']|["']$/g, '')
  }
  return undefined
}

/** zip → 一个目录。Bun.Archive 解压；先解到临时目录是「校验结构之后再改名」的前半步。 */
async function extractZip(zipFile: string, into: string): Promise<void> {
  const info = await stat(zipFile)
  if (!info.isFile()) throw new AppError(SystemErrorCode.invalidParams, `不是文件：${zipFile}`)
  const archive = new Bun.Archive(await Bun.file(zipFile).arrayBuffer())
  await archive.extract(into)
}

/** 解压出来的那棵技能树：目录里直接是 SKILL.md，或者是唯一一层壳目录。 */
async function skillRootIn(dir: string): Promise<string> {
  if (await hasSkillFile(dir)) return dir
  const entries = await Array.fromAsync(new Bun.Glob('*').scan({ cwd: dir, onlyFiles: false }))
  const directories: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry)
    if ((await stat(full)).isDirectory()) directories.push(full)
  }
  for (const candidate of directories) {
    if (await hasSkillFile(candidate)) return candidate
  }
  throw new AppError(SystemErrorCode.invalidParams, '压缩包里没有 SKILL.md')
}

async function hasSkillFile(dir: string): Promise<boolean> {
  return await stat(path.join(dir, 'SKILL.md'))
    .then((info) => info.isFile())
    .catch(() => false)
}
