import {
  Button,
  ConfirmationDialog,
  ErrorState,
  LoadingState,
  Select,
  type SelectOption,
  Switch,
  useCopy,
} from '@poietica/design-system'
import { type PluginStore, type RosterSkill, type SkillRow, skillRows } from '@poietica/extension'
import { useVirtualizer } from '@tanstack/react-virtual'
import { AlertTriangle, Check, Copy, PackageOpen, Search, Trash2 } from 'lucide-react'
import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Streamdown } from 'streamdown'
import 'streamdown/styles.css'
import './skills-settings.css'

type SourceFilter = 'all' | 'managed' | 'project' | 'user' | 'extra' | 'builtin'

type LibraryRow =
  | {
      readonly kind: 'section'
      readonly key: string
      readonly label: string
      readonly count: number
    }
  | { readonly kind: 'skill'; readonly key: string; readonly skill: SkillRow }

const SOURCE_LABELS: Record<Exclude<SourceFilter, 'all'>, string> = {
  managed: 'Poietica 管理',
  project: '当前项目',
  user: '用户目录',
  extra: '额外目录',
  builtin: 'Kimi 内置',
}

const SOURCE_ORDER: readonly Exclude<SourceFilter, 'all'>[] = [
  'managed',
  'project',
  'user',
  'extra',
  'builtin',
]

export interface SkillsSettingsProps {
  readonly roster: readonly RosterSkill[]
  readonly store: PluginStore
}

export function SkillsSettings({ roster, store }: SkillsSettingsProps) {
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<SourceFilter>('all')
  const [selectedKey, setSelectedKey] = useState<string>()
  const all = useMemo(() => skillRows(view.ownedSkills, roster), [roster, view.ownedSkills])
  const filtered = useMemo(
    () =>
      all.filter((skill) => {
        const sourceMatches = source === 'all' || sourceOf(skill) === source
        if (!sourceMatches) {
          return false
        }

        const needle = query.trim().toLocaleLowerCase()
        if (needle === '') {
          return true
        }

        return [skill.name, skill.description, skill.path, skill.source]
          .filter((value): value is string => value !== undefined)
          .join(' ')
          .toLocaleLowerCase()
          .includes(needle)
      }),
    [all, query, source],
  )
  const selected = filtered.find((skill) => skill.key === selectedKey) ?? filtered[0]
  const rows = useMemo(() => buildRows(filtered), [filtered])
  const options = useMemo(() => sourceOptions(all), [all])
  const scroll = useRef<HTMLDivElement>(null)
  const virtual = useVirtualizer({
    count: rows.length,
    estimateSize: (index) => (rows[index]?.kind === 'section' ? 30 : 56),
    getScrollElement: () => scroll.current,
    overscan: 8,
  })

  if (!view.loaded && roster.length === 0) {
    return <LoadingState label="正在扫描技能…" />
  }

  return (
    <div className="skill-library">
      <section aria-label="技能库" className="skill-library__catalog">
        <div className="skill-library__tools">
          <label className="skill-library__search">
            <Search aria-hidden="true" />
            <input
              aria-label="搜索技能"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (!['ArrowDown', 'ArrowUp'].includes(event.key) || filtered.length === 0) {
                  return
                }

                event.preventDefault()
                const current = filtered.findIndex((skill) => skill.key === selected?.key)
                const origin = current < 0 ? 0 : current
                const delta = event.key === 'ArrowDown' ? 1 : -1
                const next = (origin + delta + filtered.length) % filtered.length
                setSelectedKey(filtered[next]?.key)
              }}
              placeholder="搜索名称、说明或路径"
              value={query}
            />
          </label>

          <Select
            className="skill-library__source"
            data={options}
            onValueChange={setSource}
            type="技能来源"
            value={source}
          />
        </div>

        <div className="skill-library__list" ref={scroll}>
          {rows.length === 0 ? (
            <p className="skill-library__empty">没有匹配的技能。</p>
          ) : (
            <div className="skill-library__virtual" style={{ blockSize: virtual.getTotalSize() }}>
              {virtual.getVirtualItems().map((item) => {
                const row = rows[item.index]
                if (row === undefined) {
                  return null
                }

                return (
                  <div
                    className="skill-library__virtual-row"
                    data-index={item.index}
                    key={row.key}
                    ref={virtual.measureElement}
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    {row.kind === 'section' ? (
                      <div className="skill-library__section">
                        <span>{row.label}</span>
                        <span>{row.count}</span>
                      </div>
                    ) : (
                      <button
                        aria-current={selected?.key === row.skill.key ? 'true' : undefined}
                        className="skill-library__item"
                        data-active={selected?.key === row.skill.key ? 'true' : 'false'}
                        onClick={() => setSelectedKey(row.skill.key)}
                        type="button"
                      >
                        <span className="skill-library__glyph">
                          <PackageOpen aria-hidden="true" />
                        </span>
                        <span className="skill-library__item-copy">
                          <span>
                            <strong>{row.skill.name}</strong>
                            {!row.skill.enabled ? <em>已停用</em> : null}
                            {row.skill.issues.length > 0 ? <em data-invalid>无效</em> : null}
                          </span>
                          <small>{row.skill.description ?? sourceLabel(row.skill)}</small>
                        </span>
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <footer className="skill-library__count">
          {filtered.length === all.length
            ? `${all.length} 个技能`
            : `显示 ${filtered.length} / ${all.length}`}
        </footer>
      </section>

      <section aria-label="技能详情" className="skill-library__detail">
        {view.skillFailure ? (
          <ErrorState
            message={view.skillFailure}
            onRetry={store.retrySkills}
            title="技能操作失败"
          />
        ) : selected ? (
          <SkillDetail skill={selected} store={store} />
        ) : (
          <div className="skill-library__placeholder">
            <PackageOpen aria-hidden="true" />
            <span>选择一个技能查看详情</span>
          </div>
        )}
      </section>
    </div>
  )
}

function SkillDetail({ skill, store }: { readonly skill: SkillRow; readonly store: PluginStore }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const path = skill.path ?? ''
  const copy = useCopy(path)
  const autoInvocable = skill.type !== 'flow' && skill.disableModelInvocation !== true

  return (
    <div className="skill-detail">
      <header className="skill-detail__header">
        <span className="skill-detail__glyph">
          <PackageOpen aria-hidden="true" />
        </span>
        <div>
          <h3>{skill.name}</h3>
          <p>{sourceLabel(skill)}</p>
        </div>
        {skill.directory ? (
          <Switch
            aria-label={`${skill.enabled ? '停用' : '启用'} ${skill.name}`}
            checked={skill.enabled}
            onCheckedChange={(enabled) => store.setSkillEnabled(skill.directory ?? '', enabled)}
            size="sm"
          />
        ) : null}
      </header>

      <p className="skill-detail__description">{skill.description ?? '没有提供说明。'}</p>

      {skill.issues.length > 0 ? (
        <div className="skill-detail__warning" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>{skill.issues.join('；')}</span>
        </div>
      ) : null}

      <dl className="skill-detail__facts">
        <Fact label="调用命令">
          <code>/skill:{skill.name}</code>
        </Fact>
        <Fact label="调用方式">
          <span>{autoInvocable ? '可手动调用，也可由模型调用' : '仅手动调用'}</span>
        </Fact>
        {skill.type ? (
          <Fact label="类型">
            <code>{skill.type}</code>
          </Fact>
        ) : null}
        {skill.whenToUse ? <Fact label="适用场景">{skill.whenToUse}</Fact> : null}
        {skill.path ? (
          <Fact label="位置">
            <code title={skill.path}>{skill.path}</code>
          </Fact>
        ) : null}
        {skill.totalBytes !== undefined ? (
          <Fact label="内容">
            {skill.supportingFiles ?? 0} 个辅助文件 · {formatBytes(skill.totalBytes)}
          </Fact>
        ) : null}
        {skill.modifiedAt !== undefined ? (
          <Fact label="更新时间">
            {new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
              new Date(skill.modifiedAt * 1000),
            )}
          </Fact>
        ) : null}
      </dl>

      {skill.directory ? (
        <div className="skill-detail__actions">
          <Button
            disabled={path === ''}
            onClick={copy.copy}
            size="xs"
            type="button"
            variant="outline"
          >
            {copy.copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copy.copied ? '已复制' : '复制路径'}
          </Button>
          <Button
            onClick={() => setConfirmingDelete(true)}
            size="xs"
            type="button"
            variant="destructive"
          >
            <Trash2 aria-hidden="true" />
            移到回收站
          </Button>
        </div>
      ) : (
        <p className="skill-detail__readonly">
          这个技能由 Kimi 的项目、额外目录或内置层提供；此处只展示运行时名册，不越权修改来源文件。
        </p>
      )}

      {skill.body ? (
        <div className="skill-detail__document">
          <span>SKILL.md</span>
          <Streamdown>{skill.body}</Streamdown>
        </div>
      ) : null}

      <ConfirmationDialog
        confirmLabel="移到回收站"
        description={`会把 ${skill.name} 的整个目录移到系统回收站，可以从系统回收站恢复。`}
        destructive
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() => {
          setConfirmingDelete(false)
          if (skill.directory) {
            store.trashInstalledSkill(skill.directory)
          }
        }}
        open={confirmingDelete}
        title={`移除 ${skill.name}？`}
      />
    </div>
  )
}

function Fact({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
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

function sourceLabel(skill: SkillRow): string {
  return SOURCE_LABELS[sourceOf(skill)]
}

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

function buildRows(skills: readonly SkillRow[]): readonly LibraryRow[] {
  const groups = new Map<Exclude<SourceFilter, 'all'>, SkillRow[]>()
  for (const skill of skills) {
    const source = sourceOf(skill)
    const group = groups.get(source)
    if (group) {
      group.push(skill)
    } else {
      groups.set(source, [skill])
    }
  }

  const rows: LibraryRow[] = []
  for (const source of SOURCE_ORDER) {
    const group = groups.get(source)
    if (!group) {
      continue
    }
    rows.push({
      kind: 'section',
      key: `section:${source}`,
      label: SOURCE_LABELS[source],
      count: group.length,
    })
    for (const skill of group) {
      rows.push({ kind: 'skill', key: skill.key, skill })
    }
  }
  return rows
}

function formatBytes(value: number): string {
  const format = (amount: number) =>
    new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(amount)

  if (value < 1024) {
    return `${format(value)} B`
  }
  if (value < 1024 * 1024) {
    return `${format(value / 1024)} KB`
  }
  return `${format(value / (1024 * 1024))} MB`
}
