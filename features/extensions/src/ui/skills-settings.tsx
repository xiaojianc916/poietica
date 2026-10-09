import {
  ConfirmationDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ErrorState,
  LoadingState,
  Select,
  type SelectOption,
  Switch,
  useCopy,
} from '@poietica/design-system'
import { Check, Copy, MoreHorizontal, PackageOpen, Search, Trash2 } from 'lucide-react'
import { type Ref, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SkillInfo } from '../contract'
import type { ExtensionsApi } from './api'
import { skillDocumentOf } from './skill-document'
import './skills-settings.css'

/*
 * 技能设置页。**迁移自** legacy `packages/settings/src/ui/skills-settings.tsx` 与同名 CSS：
 * DOM、类名、文案、键盘走位、确认框照旧；数据来源换成新架构的 extensions 契约（`skills.*`），
 * 不再是 legacy 的 PluginStore。
 *
 * 与新契约的差距（已记入 docs/refactor-log.md 的偏差表）：
 *   - legacy 的来源有 builtin / managed / project / user / extra 五档；契约 `SkillInfo.source`
 *     只有 builtin / user / project 三档。legacy 的 managed 就是这里的 user（Poietica 装进
 *     agent skills/ 的那一批），extra 在新架构里没有，界面因此只画三档；
 *   - legacy 行上那个「无效」标读的是 SKILL.md 的 parse issues，契约没有这一格，不再出现；
 *   - 启停 / 删除的判据由 legacy 的「有没有 directory」换成 `source === 'user'`
 *     （契约里只有这一类可写可删，07 页 §8C）。
 *   - legacy 的技能页**没有**「从文件夹安装」/「从 zip 安装」两颗键（legacy 的
 *     `installSkill` 全仓没有调用点）；07 页 §8E 要求这一页有这两个入口，产品负责人又
 *     要求页面与 legacy 逐像素一致，所以能力改挂命令面板与快捷键（见偏差 24）。
 */

type SourceFilter = 'all' | 'managed' | 'project' | 'builtin'

/** 来源的短名。清单一行只有这么宽，长名字会把说明挤没；筛选器读同一张表。 */
const SOURCE_LABELS: Record<Exclude<SourceFilter, 'all'>, string> = {
  builtin: '内置',
  managed: '本机',
  project: '项目',
}

const SOURCE_ORDER: readonly Exclude<SourceFilter, 'all'>[] = ['builtin', 'managed', 'project']

export function SkillsSettingsPage({ api }: { readonly api: ExtensionsApi }) {
  const [skills, setSkills] = useState<readonly SkillInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<SourceFilter>('all')
  const [focusedKey, setFocusedKey] = useState<string>()
  const [trashing, setTrashing] = useState<SkillInfo>()
  const focusedRow = useRef<HTMLDivElement>(null)

  const reload = useCallback(() => {
    void api.skills.list(null).then(
      (rows) => {
        setSkills(rows)
        setFailure(null)
        setLoaded(true)
      },
      (cause: unknown) => {
        setFailure(cause instanceof Error ? cause.message : String(cause))
        setLoaded(true)
      },
    )
  }, [api])

  useEffect(() => {
    reload()
    return api.skills.onChanged(reload).dispose
  }, [api, reload])

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()

    return skills.filter((skill) => {
      if (source !== 'all' && sourceOf(skill) !== source) {
        return false
      }

      if (needle === '') {
        return true
      }

      return [skill.name, skill.description, skill.path, skill.source].join(' ').toLocaleLowerCase().includes(needle)
    })
  }, [query, skills, source])

  const options = useMemo(() => sourceOptions(skills), [skills])

  /* 键盘走位只高亮不打开，所以走到屏幕外的那一行要跟上去，否则按键没有可见的结果。 */
  useEffect(() => {
    if (focusedKey !== undefined) {
      focusedRow.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [focusedKey])

  /* 打开文档不保留选中态；高亮只跟随悬停与键盘焦点。 */
  const open = (skill: SkillInfo) => {
    void api.skills.read(skill.id).then(
      (markdown) => {
        api.openSkillDocument(skillDocumentOf(skill, markdown))
      },
      (cause: unknown) => {
        setFailure(cause instanceof Error ? cause.message : String(cause))
      },
    )
  }

  const report = (cause: unknown): void => {
    setFailure(cause instanceof Error ? cause.message : String(cause))
  }

  if (!loaded && skills.length === 0) {
    return <LoadingState label="正在扫描技能…" />
  }

  return (
    <div className="skill-page">
      {failure === null ? null : <ErrorState message={failure} onRetry={reload} title="技能操作失败" />}

      <div className="skill-page__tools">
        <label className="settings-input settings-input--with-icon">
          <Search aria-hidden="true" />
          <input
            aria-label="搜索技能"
            /* 键盘走位属于这一次键盘会话：焦点离开搜索框，那一块高亮就跟着撤掉。 */
            onBlur={() => {
              setFocusedKey(undefined)
            }}
            onChange={(event) => {
              setQuery(event.target.value)
            }}
            onKeyDown={(event) => {
              if (filtered.length === 0) {
                return
              }

              if (event.key === 'Enter') {
                const chosen = filtered.find((skill) => skill.id === focusedKey) ?? filtered[0]

                if (chosen !== undefined) {
                  event.preventDefault()
                  open(chosen)
                }

                return
              }

              if (!['ArrowDown', 'ArrowUp'].includes(event.key)) {
                return
              }

              event.preventDefault()
              const current = filtered.findIndex((skill) => skill.id === focusedKey)
              const origin = current < 0 ? 0 : current
              const delta = event.key === 'ArrowDown' ? 1 : -1
              const next = (origin + delta + filtered.length) % filtered.length

              setFocusedKey(filtered[next]?.id)
            }}
            placeholder="搜索名称、说明或路径"
            value={query}
          />
        </label>

        <Select
          className="skill-page__filter"
          data={options}
          onValueChange={setSource}
          type="技能来源"
          value={source}
        />
      </div>

      <div className="skill-list">
        {filtered.length === 0 ? (
          <p className="skill-list__empty">没有匹配的技能。</p>
        ) : (
          filtered.map((skill) => (
            <SkillListRow
              focused={skill.id === focusedKey}
              key={skill.id}
              onOpen={() => {
                open(skill)
              }}
              onToggle={(enabled) => {
                void api.skills.setEnabled(skill.id, enabled).then(reload, report)
              }}
              onTrash={() => {
                setTrashing(skill)
              }}
              ref={skill.id === focusedKey ? focusedRow : undefined}
              skill={skill}
              writable={skill.source === 'user'}
            />
          ))
        )}
      </div>

      <ConfirmationDialog
        confirmLabel="移到回收站"
        description={
          trashing === undefined ? '' : `会把 ${trashing.name} 的整个目录移到系统回收站，可以从系统回收站恢复。`
        }
        destructive
        onCancel={() => {
          setTrashing(undefined)
        }}
        onConfirm={() => {
          const skill = trashing
          setTrashing(undefined)

          if (skill !== undefined) {
            void api.skills.remove(skill.id).then(reload, report)
          }
        }}
        open={trashing !== undefined}
        title={trashing === undefined ? '' : `移除 ${trashing.name}？`}
      />
    </div>
  )
}

function SkillListRow({
  focused,
  onOpen,
  onToggle,
  onTrash,
  ref,
  skill,
  writable,
}: {
  readonly focused: boolean
  readonly onOpen: () => void
  readonly onToggle: (enabled: boolean) => void
  readonly onTrash: () => void
  /* 只给键盘走位那一行一个落脚点：走到屏幕外时它要能自己滚回来。 */
  readonly ref?: Ref<HTMLDivElement> | undefined
  readonly skill: SkillInfo
  readonly writable: boolean
}) {
  const { copied, copy } = useCopy()

  return (
    <div className="skill-list__row" data-focused={focused ? 'true' : 'false'} ref={ref}>
      <button className="skill-list__open" onClick={onOpen} type="button">
        <span className="skill-list__glyph">
          <PackageOpen aria-hidden="true" />
        </span>

        <span className="skill-list__copy">
          <span className="skill-list__title">
            <strong>{skill.name}</strong>
          </span>
          <small>{skill.description === '' ? skill.path : skill.description}</small>
        </span>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger aria-label={`${skill.name} 的更多操作`} className="skill-list__more" title="更多操作">
          <MoreHorizontal aria-hidden="true" />
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end">
          {/* 复制不关菜单：对勾就画在这一行上，关掉等于没有反馈。 */}
          <DropdownMenuItem
            closeOnClick={false}
            onClick={() => {
              copy(skill.path)
            }}
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            <span>{copied ? '已复制' : '复制路径'}</span>
          </DropdownMenuItem>

          {writable ? (
            <DropdownMenuItem onClick={onTrash}>
              <Trash2 aria-hidden="true" />
              <span>移到回收站</span>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {/*
       * 开关每一行都有，但只有写得了盘的那些拨得动。
       *
       * 别的技能启停不由这一层说了算：拨一下屏幕变了、盘上没变，那是在骗人。所以那些
       * 画成禁用，并在悬停里说明为什么 —— 先把位置占住，等启停接上了再放开。
       */}
      <span className="skill-list__switch" title={toggleHint(skill, writable)}>
        <Switch
          aria-label={`${skill.enabled ? '停用' : '启用'} ${skill.name}`}
          checked={skill.enabled}
          disabled={!writable}
          onCheckedChange={onToggle}
          size="sm"
        />
      </span>
    </div>
  )
}

function toggleHint(skill: SkillInfo, writable: boolean): string | undefined {
  return writable ? `停用 ${skill.name}` : '这个技能不由 Poietica 管理，在这里还拨不动。'
}

/* 契约的三档来源 → 这一页读的三档（见文件头注释）。 */
function sourceOf(skill: SkillInfo): Exclude<SourceFilter, 'all'> {
  if (skill.source === 'builtin' || skill.source === 'project') {
    return skill.source
  }

  return 'managed'
}

/* 来源筛选器上的读法：这一页只剩这一个地方说得出「这个技能是从哪来的」。 */
function sourceOptions(skills: readonly SkillInfo[]): readonly SelectOption<SourceFilter>[] {
  const counts = new Map<Exclude<SourceFilter, 'all'>, number>()
  for (const skill of skills) {
    const source = sourceOf(skill)
    counts.set(source, (counts.get(source) ?? 0) + 1)
  }

  return [
    { value: 'all', label: `全部 · ${skills.length}` },
    ...SOURCE_ORDER.filter((source) => counts.has(source)).map((source) => ({
      value: source,
      label: `${SOURCE_LABELS[source]} · ${counts.get(source) ?? 0}`,
    })),
  ]
}
