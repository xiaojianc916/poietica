import type { AgentSkill } from '@poietica/conversation'
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
import { type PluginStore, type SkillRow, skillRows } from '@poietica/extension'
import { Check, Copy, MoreHorizontal, PackageOpen, Search, Trash2 } from 'lucide-react'
import { type Ref, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import './skills-settings.css'

type SourceFilter = 'all' | 'managed' | 'project' | 'user' | 'extra' | 'builtin'

const SOURCE_LABELS: Record<Exclude<SourceFilter, 'all'>, string> = {
  builtin: '内置',
  managed: '本机',
  project: '项目',
  user: '用户',
  extra: '额外',
}

const SOURCE_ORDER: readonly Exclude<SourceFilter, 'all'>[] = [
  'builtin',
  'managed',
  'project',
  'user',
  'extra',
]

export interface SkillsSettingsProps {
  readonly store: PluginStore
  /** 技能名册由组合根注入，不在设置页另行读取。 */
  readonly skills: readonly AgentSkill[]
  /**
   * 看一个技能的 SKILL.md。落在哪一列由组合根说了算：这一层不认识工作台的右侧栏，
   * 它只负责说「人要看这一个」。
   */
  readonly openSkillDocument: (skillId: string) => void
}

export function SkillsSettings({ skills, store, openSkillDocument }: SkillsSettingsProps) {
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<SourceFilter>('all')
  const [focusedKey, setFocusedKey] = useState<string>()
  const [trashing, setTrashing] = useState<SkillRow>()
  const all = useMemo(() => skillRows(skills), [skills])
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()

    return all.filter((skill) => {
      if (source !== 'all' && sourceOf(skill) !== source) {
        return false
      }

      if (needle === '') {
        return true
      }

      return [skill.name, skill.description, skill.path, skill.source]
        .filter((value): value is string => value !== undefined)
        .join(' ')
        .toLocaleLowerCase()
        .includes(needle)
    })
  }, [all, query, source])
  const options = useMemo(() => sourceOptions(all), [all])
  const focusedRow = useRef<HTMLDivElement>(null)

  /* 键盘走位只高亮不打开，所以走到屏幕外的那一行要跟上去，否则按键没有可见的结果。 */
  useEffect(() => {
    if (focusedKey !== undefined) {
      focusedRow.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [focusedKey])

  /* 打开文档不保留选中态；高亮只跟随悬停与键盘焦点。 */
  const open = (skill: SkillRow) => {
    openSkillDocument(skill.key)
  }

  if (!view.loaded && skills.length === 0) {
    return <LoadingState label="正在扫描技能…" />
  }

  return (
    <div className="skill-page">
      {view.skillFailure ? (
        <ErrorState message={view.skillFailure} onRetry={store.retrySkills} title="技能操作失败" />
      ) : null}

      <div className="skill-page__tools">
        <label className="settings-input settings-input--with-icon">
          <Search aria-hidden="true" />
          <input
            aria-label="搜索技能"
            /* 键盘走位属于这一次键盘会话：焦点离开搜索框，那一块高亮就跟着撤掉。 */
            onBlur={() => {
              setFocusedKey(undefined)
            }}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (filtered.length === 0) {
                return
              }

              if (event.key === 'Enter') {
                const chosen = filtered.find((skill) => skill.key === focusedKey) ?? filtered[0]

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
              const current = filtered.findIndex((skill) => skill.key === focusedKey)
              const origin = current < 0 ? 0 : current
              const delta = event.key === 'ArrowDown' ? 1 : -1
              const next = (origin + delta + filtered.length) % filtered.length

              setFocusedKey(filtered[next]?.key)
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
              focused={skill.key === focusedKey}
              key={skill.key}
              onOpen={() => {
                open(skill)
              }}
              onTrash={() => {
                setTrashing(skill)
              }}
              ref={skill.key === focusedKey ? focusedRow : undefined}
              skill={skill}
              store={store}
            />
          ))
        )}
      </div>

      <ConfirmationDialog
        confirmLabel="移到回收站"
        description={
          trashing === undefined
            ? ''
            : `会把 ${trashing.name} 的整个目录移到系统回收站，可以从系统回收站恢复。`
        }
        destructive
        onCancel={() => {
          setTrashing(undefined)
        }}
        onConfirm={() => {
          if (trashing?.directory !== undefined) {
            store.trashInstalledSkill(trashing.directory)
          }

          setTrashing(undefined)
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
  onTrash,
  ref,
  skill,
  store,
}: {
  readonly focused: boolean
  readonly onOpen: () => void
  readonly onTrash: () => void
  /* 只给键盘走位那一行一个落脚点：走到屏幕外时它要能自己滚回来。 */
  readonly ref?: Ref<HTMLDivElement> | undefined
  readonly skill: SkillRow
  readonly store: PluginStore
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
            {skill.issues.length > 0 ? <em data-invalid>无效</em> : null}
          </span>
          <small>{skill.description ?? skill.path}</small>
        </span>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`${skill.name} 的更多操作`}
          className="skill-list__more"
          title="更多操作"
        >
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

          {skill.directory === undefined ? null : (
            <DropdownMenuItem onClick={onTrash}>
              <Trash2 aria-hidden="true" />
              <span>移到回收站</span>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/*
       * 开关每一行都有，但只有写得了盘的那些拨得动。
       *
       * 别的技能启停不由这一层说了算：拨一下屏幕变了、盘上没变，那是在骗人。所以那些
       * 画成禁用，并在悬停里说明为什么 —— 先把位置占住，等启停接上了再放开。
       */}
      <span className="skill-list__switch" title={toggleHint(skill)}>
        <Switch
          aria-label={`${skill.enabled ? '停用' : '启用'} ${skill.name}`}
          checked={skill.enabled}
          disabled={skill.directory === undefined}
          onCheckedChange={(enabled) => {
            if (skill.directory !== undefined) {
              store.setSkillEnabled(skill.directory, enabled)
            }
          }}
          size="sm"
        />
      </span>
    </div>
  )
}

function toggleHint(skill: SkillRow): string | undefined {
  return skill.directory === undefined
    ? '这个技能不由 Poietica 管理，在这里还拨不动。'
    : `停用 ${skill.name}`
}

function sourceOf(skill: SkillRow): Exclude<SourceFilter, 'all'> {
  if (skill.directory !== undefined) {
    return 'managed'
  }
  if (skill.source === 'project' || skill.source === 'extra' || skill.source === 'builtin') {
    return skill.source
  }
  return 'user'
}

/* 来源筛选器上的读法：这一页只剩这一个地方说得出「这个技能是从哪来的」。 */
function sourceOptions(skills: readonly SkillRow[]): readonly SelectOption<SourceFilter>[] {
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
