import {
  Button,
  ConfirmationDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  SegmentedControl,
  type SegmentedOption,
  Switch,
} from '@poietica/design-system'
import { Check, ChevronDown, Download, Monitor, Plus, RotateCw, Search } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import type { McpServerInfo, McpStatus } from '../contract'
import type { ExtensionsApi } from './api'
import { builtinServerRows, groupRows, matches } from './catalog'
import { CatalogGrid } from './catalog-grid'
import { type McpEntry, mcpEntryFromForm, parseMcpImport } from './mcp-config'
import { PluginGlyph } from './plugin-glyph'

import './mcp-settings.css'

/*
 * MCP 设置页。**迁移自** legacy `packages/extension/src/ui/mcp-settings.tsx` 与同名 CSS：
 * DOM、类名、文案、图标、两副面孔（列表 / 新建）与导入勾选全部照旧；数据来源换成新架构的
 * extensions 契约（`mcp.*`），不再经 legacy 的 PluginStore。
 *
 * 与新契约的差距（见 docs/refactor-log.md 待决 Q23）：
 *   - legacy 的每台服务器带 `origin`（用户 / 插件）与 `launchedBy`（谁起它）；契约
 *     `McpServerInfo` 只有 name / transport / enabled / config，卡片的说明行因此只有
 *     「个人」这一种来源，绿点改读会话报回来的连接状态；
 *   - legacy 的列表顺序与「工作区」置灰行照旧，作用域这一档在契约里同样只支持用户。
 */

type CreateTab = 'form' | 'json'

const CREATE_MODES = [
  { value: 'form', label: '表单' },
  { value: 'json', label: 'JSON' },
] as const satisfies readonly SegmentedOption<CreateTab>[]

type McpTransport = 'stdio' | 'http' | 'sse'

const TRANSPORT_MODES = [
  { value: 'stdio', label: 'stdio（本地命令）' },
  { value: 'http', label: 'HTTP（远程）' },
  { value: 'sse', label: 'SSE' },
] as const satisfies readonly SegmentedOption<McpTransport>[]

/*
 * 本应用自己托管的内置服务器：自动化引擎。它写进同一份 mcp.json，但删了就等于把应用的
 * 核心能力拆了，所以不允许删除（legacy 的 BUILTIN_MANAGED_SERVERS，一字未改）。
 */
const BUILTIN_MANAGED_SERVERS = ['poietica-automations'] as const

export function McpSettingsPage({ api }: { readonly api: ExtensionsApi }) {
  const [servers, setServers] = useState<readonly McpServerInfo[]>([])
  const [statuses, setStatuses] = useState<readonly McpStatus[]>([])
  const [loaded, setLoaded] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [needle, setNeedle] = useState('')
  const [tab, setTab] = useState<CreateTab | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const report = useCallback((cause: unknown): void => {
    setFailure(cause instanceof Error ? cause.message : String(cause))
  }, [])

  const reload = useCallback(() => {
    setBusy(true)
    return Promise.all([api.mcp.list(), api.mcp.status()]).then(
      ([rows, states]) => {
        setServers(rows)
        setStatuses(states)
        setFailure(null)
        setLoaded(true)
        setBusy(false)
      },
      (cause: unknown) => {
        report(cause)
        setLoaded(true)
        setBusy(false)
      },
    )
  }, [api, report])

  useEffect(() => {
    void reload()
    return api.mcp.onStatusChanged(setStatuses).dispose
  }, [api, reload])

  /*
   * 写一条配置。新契约只有幂等的 `mcp.upsert`（05 页 §11 没有「新增 / 更新」的意图位，
   * 见 docs/refactor-log.md 的 Q21），所以新建走的就是它：同名即更新。
   */
  const upsert = useCallback(
    (entry: McpEntry): Promise<void> => {
      setBusy(true)
      return api.mcp.upsert({ name: entry.name, transport: entry.transport, enabled: true, config: entry.config }).then(
        () => reload(),
        (cause: unknown) => {
          setBusy(false)
          report(cause)
          throw cause
        },
      )
    },
    [api, reload, report],
  )

  if (tab !== null) {
    return (
      <McpCreatePage busy={busy} failure={failure} initialTab={tab} onClose={() => setTab(null)} onUpsert={upsert} />
    )
  }

  const query = needle.trim()
  const installedServers = servers.filter((server) => matches(query, server.name, '个人 用户'))

  return (
    <section aria-label="MCP 服务器管理" className="mcp">
      <div className="mcp__filter">
        <ScopePill />
        <span aria-hidden="true" className="mcp__divider" />
        <span className="mcp__count">
          MCP <span className="mcp__muted">{servers.length}</span>
        </span>
        <span className="mcp__search">
          <Search aria-hidden="true" size={15} />
          <input
            aria-label="搜索 MCP 服务器"
            onChange={(event) => setNeedle(event.target.value)}
            placeholder="搜索 MCP 服务器..."
            type="search"
            value={needle}
          />
        </span>
      </div>

      <div className="mcp__installed">
        <span className="mcp__count">已安装</span>
        <div className="mcp__toolbar">
          <button aria-label="导入 JSON" className="mcp__icon-btn" onClick={() => setTab('json')} type="button">
            <Download aria-hidden="true" size={14} />
          </button>
          <button
            aria-label="刷新"
            className="mcp__icon-btn"
            disabled={busy}
            onClick={() => void reload()}
            type="button"
          >
            <span className={busy ? 'mcp__spin' : undefined}>
              <RotateCw aria-hidden="true" size={14} />
            </span>
          </button>
          <Button disabled={busy} onClick={() => setTab('form')} size="sm" type="button" variant="soft">
            <Plus aria-hidden="true" size={13} />
            新建
          </Button>
        </div>
      </div>

      {failure === null ? null : (
        <p className="mcp__error" role="alert">
          {failure}
        </p>
      )}

      {!loaded ? (
        <p className="mcp__muted" role="status">
          正在读取 MCP 配置…
        </p>
      ) : query !== '' && installedServers.length === 0 ? (
        <div className="mcp__empty">
          <strong>没有匹配的 MCP 服务器</strong>
          <p>试试其他名称，或清空搜索。</p>
        </div>
      ) : installedServers.length === 0 && query === '' ? (
        <div className="mcp__empty">
          <strong>尚未安装 MCP 服务器</strong>
          <p>手动新建服务器，或导入已有配置。</p>
          <div className="mcp__empty-actions">
            <button className="mcp__primary mcp__primary--lg" onClick={() => setTab('form')} type="button">
              <Plus aria-hidden="true" size={14} />
              新建 MCP 服务器
            </button>
            <button className="mcp__outline" onClick={() => setTab('json')} type="button">
              <Download aria-hidden="true" size={14} />
              导入
            </button>
          </div>
        </div>
      ) : (
        <ul className="mcp__cards">
          {installedServers.map((server) => (
            <ServerCard
              busy={busy}
              key={server.name}
              live={server.enabled && statuses.find((state) => state.name === server.name)?.state === 'connected'}
              onRemove={() => setRemoving(server.name)}
              onToggle={(enabled) => {
                void api.mcp.upsert({ ...server, enabled }).then(reload, report)
              }}
              removable={!BUILTIN_MANAGED_SERVERS.includes(server.name as (typeof BUILTIN_MANAGED_SERVERS)[number])}
              server={server}
            />
          ))}
        </ul>
      )}

      <CatalogGrid
        action={{
          install: (name, body) => {
            void upsert({
              name,
              transport: body.url === undefined ? 'stdio' : 'http',
              config: body,
            }).catch(() => undefined)
          },
        }}
        groups={groupRows(builtinServerRows(servers, query))}
      />

      <ConfirmationDialog
        busy={busy}
        confirmLabel="删除配置"
        description={
          failure ?? '仅删除这台服务器的用户配置，不删除程序文件。已有会话的调用可能失效；此操作不能从界面撤销。'
        }
        destructive
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const name = removing

          if (name === null) {
            return
          }

          setBusy(true)
          void api.mcp.remove(name).then(
            () => {
              setRemoving(null)
              void reload()
            },
            (cause: unknown) => {
              setBusy(false)
              report(cause)
            },
          )
        }}
        open={removing !== null}
        title={`删除 ${removing ?? ''}？`}
      />
    </section>
  )
}

/*
 * 作用域下拉：只有“用户”能点。工作区后端不存在，画出分组与置灰行只是为了
 * 与设计稿同形，点不了，也不会把不生效的开关列出来。
 */
function ScopePill() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="mcp__scope">
        <Monitor aria-hidden="true" size={14} />
        用户
        <ChevronDown aria-hidden="true" size={13} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="mcp__scope-menu">
        <DropdownMenuItem onClick={() => undefined}>
          <Monitor aria-hidden="true" size={14} />
          用户
          <Check aria-hidden="true" size={14} />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled>
          <span className="mcp__muted">工作区</span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled>当前仅支持用户作用域</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ServerCard({
  busy,
  live,
  onRemove,
  onToggle,
  removable,
  server,
}: {
  readonly busy: boolean
  readonly live: boolean
  readonly onRemove: () => void
  readonly onToggle: (enabled: boolean) => void
  readonly removable?: boolean
  readonly server: McpServerInfo
}) {
  const description = `个人 · ${server.enabled ? '已启用 · 连接状态由会话确认' : '已停用'}`

  return (
    <li className="mcp-card">
      <span className="mcp-card__icon">
        <PluginGlyph displayName={server.name} id={server.name} />
        <i aria-hidden="true" className="mcp-card__dot" data-live={live ? 'true' : 'false'} />
      </span>
      <div className="mcp-card__copy">
        <strong>{server.name}</strong>
        <span>{description}</span>
      </div>
      <div className="mcp-card__actions">
        {removable === true ? (
          <Button disabled={busy} onClick={onRemove} size="xs" type="button" variant="dangerSoft">
            删除
          </Button>
        ) : null}
        <Switch
          aria-label={`启用 ${server.name}`}
          checked={server.enabled}
          disabled={busy}
          onCheckedChange={onToggle}
          size="sm"
        />
      </div>
    </li>
  )
}

function McpCreatePage({
  busy,
  failure,
  initialTab,
  onClose,
  onUpsert,
}: {
  readonly busy: boolean
  readonly failure: string | null
  readonly initialTab: CreateTab
  readonly onClose: () => void
  readonly onUpsert: (entry: McpEntry) => Promise<void>
}) {
  const [tab, setTab] = useState<CreateTab>(initialTab)

  return (
    <section aria-label="新建 MCP 服务器" className="mcp">
      <div className="mcp-create__head">
        <div className="mcp-create__title">
          <nav aria-label="面包屑" className="mcp-breadcrumb">
            <button className="mcp-breadcrumb__link" onClick={onClose} type="button">
              MCP 服务器
            </button>
            <span aria-hidden="true" className="mcp-breadcrumb__separator">
              ›
            </span>
            <span className="mcp-breadcrumb__current">新建 MCP 服务器</span>
          </nav>
          <div>
            <h1 className="mcp__title">新建 MCP 服务器</h1>
            <p className="mcp__muted">填写新的 MCP 配置，保存后返回列表。</p>
          </div>
        </div>
        <SegmentedControl
          label="编辑方式"
          name="mcp-create-mode"
          onValueChange={setTab}
          options={CREATE_MODES}
          value={tab}
        />
      </div>
      {tab === 'form' ? (
        <McpFormPage busy={busy} failure={failure} onClose={onClose} onUpsert={onUpsert} />
      ) : (
        <McpJsonPage busy={busy} failure={failure} onClose={onClose} onUpsert={onUpsert} />
      )}
    </section>
  )
}

const EMPTY_ENTRY: McpEntry = { name: '', transport: 'stdio', config: { command: '', args: [] } }

function McpFormPage({
  busy,
  failure,
  onClose,
  onUpsert,
}: {
  readonly busy: boolean
  readonly failure: string | null
  readonly onClose: () => void
  readonly onUpsert: (entry: McpEntry) => Promise<void>
}) {
  const form = useRef<HTMLFormElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [valid, setValid] = useState(false)

  const checkValid = () => {
    const element = form.current

    if (element === null) {
      setValid(false)
      return
    }

    const fields = new FormData(element)
    const text = (key: string) => {
      const value = fields.get(key)
      return typeof value === 'string' ? value.trim() : ''
    }
    const transport = text('transport') || 'stdio'
    setValid(text('name') !== '' && (transport === 'stdio' ? text('command') !== '' : text('url') !== ''))
  }
  useEffect(checkValid, [])

  const submit = (event: FormEvent) => {
    event.preventDefault()

    if (busy || form.current === null) {
      return
    }

    const fields: Record<string, string> = {}

    for (const [name, value] of new FormData(form.current)) {
      if (typeof value === 'string') {
        fields[name] = value
      }
    }

    /* 表单校验不抛异常（C 类）：不合法时把原样文案交给字段旁边那一行。 */
    const validated = mcpEntryFromForm(fields)
    if (!validated.ok) {
      setError(validated.message)
      return
    }
    setError(null)
    void onUpsert(validated.value).then(onClose, (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : '配置无效。')
    })
  }

  return (
    <form className="mcp-create__card" onChange={checkValid} onSubmit={submit} ref={form}>
      <fieldset disabled={busy}>
        <McpFields entry={EMPTY_ENTRY} />
        {error === null && failure === null ? null : (
          <p className="mcp__error" role="alert">
            {error ?? failure}
          </p>
        )}
        <div className="mcp-create__footer">
          <Button disabled={busy || !valid} type="submit" variant="soft">
            {busy ? '保存中…' : '保存'}
          </Button>
          <button className="mcp__text-btn" disabled={busy} onClick={onClose} type="button">
            取消
          </button>
        </div>
      </fieldset>
    </form>
  )
}

function McpJsonPage({
  busy,
  failure,
  onClose,
  onUpsert,
}: {
  readonly busy: boolean
  readonly failure: string | null
  readonly onClose: () => void
  readonly onUpsert: (entry: McpEntry) => Promise<void>
}) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  let entries: readonly McpEntry[] = []
  let parseError: string | null = null

  if (text.trim() !== '') {
    const parsed = parseMcpImport(text)
    if (parsed.ok) {
      entries = parsed.value
    } else {
      parseError = parsed.message
    }
  }

  const save = () => {
    setError(null)

    try {
      const items = entries.filter((entry) => selected.has(entry.name))

      void Promise.all(items.map((entry) => onUpsert(entry))).then(onClose, (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : '配置无效。')
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '配置无效。')
    }
  }

  return (
    <div className="mcp-create__card">
      <div className="mcp-create__scope">
        <span className="mcp__muted">作用域</span>
        <ScopePill />
      </div>
      <label className="mcp-field">
        <span className="mcp__muted">完整配置</span>
        <textarea
          autoComplete="off"
          className="mcp__code"
          disabled={busy}
          onChange={(event) => {
            setText(event.target.value)
            setSelected(new Set())
            setError(null)
          }}
          placeholder={'{\n  "my-mcp-server": {\n    "type": "stdio",\n    "command": "",\n    "args": []\n  }\n}'}
          rows={12}
          spellCheck={false}
          value={text}
        />
      </label>
      <p className="mcp__muted">
        支持直接粘贴 {'{"server-name": {...}}'} 或 {'{"mcpServers": {"server-name": {...}}}'}。
      </p>
      {parseError === null ? null : (
        <p className="mcp__error" role="alert">
          {parseError}
        </p>
      )}
      {entries.length === 0 ? null : (
        <fieldset className="mcp__checks" disabled={busy}>
          <legend className="mcp__muted">
            选择要导入的服务器（{selected.size}/{entries.length}）
          </legend>
          <label className="mcp__check">
            <input
              checked={selected.size === entries.length}
              onChange={(event) => setSelected(new Set(event.target.checked ? entries.map((entry) => entry.name) : []))}
              type="checkbox"
            />
            全选
          </label>
          {entries.map((entry) => (
            <label className="mcp__check" key={entry.name}>
              <input
                checked={selected.has(entry.name)}
                onChange={(event) => {
                  const next = new Set(selected)

                  if (event.target.checked) {
                    next.add(entry.name)
                  } else {
                    next.delete(entry.name)
                  }

                  setSelected(next)
                }}
                type="checkbox"
              />
              {entry.name}
            </label>
          ))}
        </fieldset>
      )}
      {error === null && failure === null ? null : (
        <p className="mcp__error" role="alert">
          {error ?? failure}
        </p>
      )}
      <div className="mcp-create__footer">
        <Button
          disabled={busy || selected.size === 0 || parseError !== null}
          onClick={save}
          type="button"
          variant="soft"
        >
          {busy ? '保存中…' : '保存'}
        </Button>
        <button className="mcp__text-btn" disabled={busy} onClick={onClose} type="button">
          取消
        </button>
      </div>
    </div>
  )
}

function McpFields({ entry }: { readonly entry: McpEntry }) {
  const { config, transport: declaredTransport } = entry
  const [transport, setTransport] = useState<McpTransport>(declaredTransport)
  const [envOpen, setEnvOpen] = useState(false)
  const text = (key: string) =>
    typeof config[key] === 'string' || typeof config[key] === 'number' ? String(config[key]) : ''
  const json = (key: string, fallback: unknown) => JSON.stringify(config[key] ?? fallback, null, 2)

  return (
    <div className="mcp-form">
      <div className="mcp-form__row">
        <label className="mcp-field mcp-field--narrow">
          <span className="mcp__muted">名称</span>
          <input name="name" placeholder="my-mcp-server" required />
        </label>
        <span className="mcp-form__scope">
          <span className="mcp__muted">作用域</span>
          <ScopePill />
        </span>
      </div>
      <div className="mcp-field mcp-field--narrow">
        <span className="mcp__muted">类型</span>
        <SegmentedControl
          label="类型"
          name="transport"
          onValueChange={setTransport}
          options={TRANSPORT_MODES}
          value={transport}
        />
      </div>
      <label className="mcp-field mcp-field--narrow">
        <span className="mcp__muted">超时时间 MS</span>
        <input
          defaultValue={text('startupTimeoutMs')}
          max={2147483647}
          min={1}
          name="startupTimeoutMs"
          placeholder="30000"
          step={1}
          type="number"
        />
      </label>
      {transport === 'stdio' ? (
        <>
          <label className="mcp-field">
            <span className="mcp__muted">命令</span>
            <input defaultValue={text('command')} name="command" placeholder="npx" required />
          </label>
          <label className="mcp-field">
            <span className="mcp__muted">参数（JSON 字符串数组）</span>
            <textarea
              defaultValue={json('args', [])}
              name="args"
              placeholder='["-y", "@modelcontextprotocol/server-memory"]'
              rows={2}
              spellCheck={false}
            />
          </label>
          <label className="mcp-field">
            <span className="mcp__muted">工作目录（可选）</span>
            <input defaultValue={text('cwd')} name="cwd" placeholder="留空使用默认目录" />
          </label>
        </>
      ) : (
        <>
          <label className="mcp-field">
            <span className="mcp__muted">服务器 URL</span>
            <input defaultValue={text('url')} name="url" placeholder="https://example.com/mcp" required type="url" />
          </label>
          <label className="mcp-field">
            <span className="mcp__muted">令牌环境变量名（可选）</span>
            <input defaultValue={text('bearerTokenEnvVar')} name="bearerTokenEnvVar" placeholder="MCP_TOKEN" />
          </label>
          <label className="mcp-field">
            <span className="mcp__muted">请求头（JSON，可选）</span>
            <textarea
              autoComplete="off"
              defaultValue={json('headers', {})}
              name="headers"
              rows={2}
              spellCheck={false}
            />
          </label>
        </>
      )}
      <div className="mcp-field">
        <button
          aria-expanded={envOpen}
          className="mcp-form__collapsible"
          onClick={() => setEnvOpen((open) => !open)}
          type="button"
        >
          <span className={envOpen ? 'mcp-form__chevron mcp-form__chevron--open' : 'mcp-form__chevron'}>
            <ChevronDown aria-hidden="true" size={13} />
          </span>
          环境变量（可选）
        </button>
        {envOpen ? (
          <textarea
            autoComplete="off"
            className="mcp__code"
            defaultValue={json('env', {})}
            name="env"
            placeholder={'{\n  "MY_API_KEY": "your-key"\n}'}
            rows={4}
            spellCheck={false}
          />
        ) : null}
      </div>
    </div>
  )
}
