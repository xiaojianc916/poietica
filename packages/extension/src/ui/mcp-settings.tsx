import {
  Button,
  ConfirmationDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Switch,
} from '@poietica/design-system'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Download,
  Ellipsis,
  Monitor,
  Plus,
  RotateCw,
  Search,
} from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { builtinServerRows, groupRows, matches } from '../catalog/listing'
import { type McpEntry, mcpEntryFromForm, parseMcpImport } from '../mcp-config'
import type { ResolvedMcpServer } from '../mcp-servers'
import type { PluginStore } from '../plugin-store'
import { CatalogGrid } from './catalog-grid'
import { PluginGlyph } from './plugin-glyph'
import './mcp-settings.css'

/*
 * MCP 设置页：列表与新建是同一页面的两副面孔，图片里的“新建 / JSON / 导入”
 * 都是在这个文件里切换的子视图，不开弹窗。
 *
 * 能管的只有本应用 Agent 用户目录那一份（mcp.json）：作用域下拉里只有“用户”
 * 是可点的，工作区一行是置灰的占位；开关拨的是“允许装载”，连没连上只有会话
 * 知道，所以卡片上只有启用绿点 / 停用灰点，没有连接健康色。
 */

type CreateTab = 'form' | 'json'

export function McpSettings({ store }: { readonly store: PluginStore }) {
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [needle, setNeedle] = useState('')
  const [tab, setTab] = useState<CreateTab | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const busy = view.mcpPending > 0
  useEffect(() => {
    store.refreshMcpServers()
  }, [store])

  if (tab !== null) {
    return <McpCreatePage initialTab={tab} onClose={() => setTab(null)} store={store} />
  }

  const query = needle.trim()
  const userServers = view.mcpServers.filter(
    (server) => server.origin.kind === 'user' && matches(query, server.name, '个人 用户'),
  )
  const pluginServers = view.mcpServers.filter(
    (server) =>
      server.origin.kind === 'plugin' && matches(query, server.name, server.origin.pluginId),
  )
  const pluginGroups = groupPluginServers(pluginServers)

  return (
    <section aria-label="MCP 服务器管理" className="mcp">
      <h1 className="mcp__title">MCP 服务器</h1>
      <div className="mcp__filter">
        <ScopePill />
        <span aria-hidden="true" className="mcp__divider" />
        <span className="mcp__count">
          MCP <span className="mcp__muted">{view.mcpServers.length}</span>
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
        <span className="mcp__count">
          已安装 <span className="mcp__muted">{userServers.length}</span>
        </span>
        <div className="mcp__toolbar">
          <DropdownMenu>
            <DropdownMenuTrigger aria-label="更多操作" className="mcp__icon-btn">
              <Ellipsis aria-hidden="true" size={16} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setTab('json')}>
                <Download aria-hidden="true" size={15} />
                导入 JSON
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            aria-label="刷新"
            className="mcp__icon-btn"
            disabled={busy}
            onClick={store.refreshMcpServers}
            type="button"
          >
            <span className={busy ? 'mcp__spin' : undefined}>
              <RotateCw aria-hidden="true" size={15} />
            </span>
          </button>
          <button
            className="mcp__primary"
            disabled={busy}
            onClick={() => setTab('form')}
            type="button"
          >
            <Plus aria-hidden="true" size={13} />
            新建
          </button>
        </div>
      </div>

      {view.mcpFailure ? (
        <p className="mcp__error" role="alert">
          {view.mcpFailure}
        </p>
      ) : null}

      {!view.loaded ? (
        <p className="mcp__muted" role="status">
          正在读取 MCP 配置…
        </p>
      ) : query !== '' && userServers.length === 0 && pluginServers.length === 0 ? (
        <div className="mcp__empty">
          <strong>没有匹配的 MCP 服务器</strong>
          <p>试试其他名称，或清空搜索。</p>
        </div>
      ) : userServers.length === 0 && query === '' ? (
        <div className="mcp__empty">
          <strong>尚未安装 MCP 服务器</strong>
          <p>手动新建服务器，或导入已有配置。</p>
          <div className="mcp__empty-actions">
            <button
              className="mcp__primary mcp__primary--lg"
              onClick={() => setTab('form')}
              type="button"
            >
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
          {userServers.map((server) => (
            <ServerCard
              busy={busy}
              key={`user/${server.name}`}
              onRemove={() => setRemoving(server.name)}
              onToggle={(enabled) => store.setMcpServerEnabled(server.origin, server.name, enabled)}
              removable
              server={server}
            />
          ))}
        </ul>
      )}

      {pluginGroups.map((group) => (
        <div className="mcp__group" key={group.title}>
          <h2 className="mcp__group-title">
            {group.title} <span className="mcp__muted">{group.rows.length}</span>
          </h2>
          <ul className="mcp__cards">
            {group.rows.map((server) => (
              <ServerCard
                busy={busy}
                key={`plugin/${group.title}/${server.name}`}
                onToggle={(enabled) =>
                  store.setMcpServerEnabled(server.origin, server.name, enabled)
                }
                server={server}
              />
            ))}
          </ul>
        </div>
      ))}

      <CatalogGrid
        action={{
          kind: 'server',
          install: store.installEnvironmentServer,
          resolveLauncher: store.resolveLauncher,
        }}
        groups={groupRows(builtinServerRows(view.mcpServers, query))}
      />

      <ConfirmationDialog
        busy={busy}
        confirmLabel="删除配置"
        description={
          view.mcpFailure ??
          '仅删除这台服务器的用户配置，不删除程序文件。已有会话的调用可能失效；此操作不能从界面撤销。'
        }
        destructive
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing !== null) {
            void store.removeEnvironmentServer(removing).then((saved) => {
              if (saved) {
                setRemoving(null)
              }
            })
          }
        }}
        open={removing !== null}
        title={`删除 ${removing ?? ''}？`}
      />
    </section>
  )
}

/* 插件带来的服务器按插件号分组：同一家的收在一组里，组名就是插件号。 */
function groupPluginServers(servers: readonly ResolvedMcpServer[]): readonly {
  readonly title: string
  readonly rows: readonly ResolvedMcpServer[]
}[] {
  const buckets = new Map<string, ResolvedMcpServer[]>()
  for (const server of servers) {
    if (server.origin.kind !== 'plugin') {
      continue
    }
    const bucket = buckets.get(server.origin.pluginId)
    if (bucket === undefined) {
      buckets.set(server.origin.pluginId, [server])
    } else {
      bucket.push(server)
    }
  }
  return [...buckets.entries()].map(([title, rows]) => ({ title, rows }))
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
  onRemove,
  onToggle,
  removable,
  server,
}: {
  readonly busy: boolean
  readonly onRemove?: () => void
  readonly onToggle: (enabled: boolean) => void
  readonly removable?: boolean
  readonly server: ResolvedMcpServer
}) {
  const live = server.enabled && server.launchedBy !== 'none'
  const description =
    server.origin.kind === 'user'
      ? `个人 · ${server.enabled ? '已启用 · 连接状态由会话确认' : '已停用'}`
      : `${server.origin.pluginId} · ${!server.enabled ? '已停用' : server.launchedBy === 'none' ? '插件已停用' : '已启用 · 连接状态由会话确认'}`
  return (
    <li className="mcp-card">
      <span className="mcp-card__icon">
        <PluginGlyph displayName={server.name} id={server.name} size="md" />
        <i aria-hidden="true" className="mcp-card__dot" data-live={live ? 'true' : 'false'} />
      </span>
      <div className="mcp-card__copy">
        <strong>{server.name}</strong>
        <span>{description}</span>
      </div>
      <div className="mcp-card__actions">
        {removable === true && onRemove !== undefined ? (
          <Button disabled={busy} onClick={onRemove} size="xs" type="button" variant="ghost">
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
  initialTab,
  onClose,
  store,
}: {
  readonly initialTab: CreateTab
  readonly onClose: () => void
  readonly store: PluginStore
}) {
  const [tab, setTab] = useState<CreateTab>(initialTab)
  return (
    <section aria-label="新建 MCP 服务器" className="mcp">
      <div className="mcp-create__head">
        <div className="mcp-create__title">
          <button
            aria-label="返回 MCP 列表"
            className="mcp__icon-btn"
            onClick={onClose}
            type="button"
          >
            <ArrowLeft aria-hidden="true" size={15} />
          </button>
          <div>
            <h1 className="mcp__title">新建 MCP 服务器</h1>
            <p className="mcp__muted">填写新的 MCP 配置，保存后返回列表。</p>
          </div>
        </div>
        <div aria-label="编辑方式" className="mcp-create__tabs" role="tablist">
          <button
            aria-selected={tab === 'form'}
            className="mcp-create__tab"
            data-active={tab === 'form' ? 'true' : 'false'}
            onClick={() => setTab('form')}
            role="tab"
            type="button"
          >
            表单
          </button>
          <button
            aria-selected={tab === 'json'}
            className="mcp-create__tab"
            data-active={tab === 'json' ? 'true' : 'false'}
            onClick={() => setTab('json')}
            role="tab"
            type="button"
          >
            JSON
          </button>
        </div>
      </div>
      {tab === 'form' ? (
        <McpFormPage onClose={onClose} store={store} />
      ) : (
        <McpJsonPage onClose={onClose} store={store} />
      )}
    </section>
  )
}

const EMPTY_ENTRY: McpEntry = { name: '', body: { command: '', args: [] } }

function McpFormPage({
  onClose,
  store,
}: {
  readonly onClose: () => void
  readonly store: PluginStore
}) {
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const form = useRef<HTMLFormElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [valid, setValid] = useState(false)
  const busy = view.mcpPending > 0

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
    setValid(
      text('name') !== '' && (transport === 'stdio' ? text('command') !== '' : text('url') !== ''),
    )
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
    try {
      const entry = mcpEntryFromForm(fields, { ...EMPTY_ENTRY.body })
      setError(null)
      void store.addEnvironmentServers([entry]).then((saved) => {
        if (saved) {
          onClose()
        }
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '配置无效。')
    }
  }

  return (
    <form className="mcp-create__card" onChange={checkValid} onSubmit={submit} ref={form}>
      <fieldset disabled={busy}>
        <McpFields entry={EMPTY_ENTRY} />
        {error || view.mcpFailure ? (
          <p className="mcp__error" role="alert">
            {error ?? view.mcpFailure}
          </p>
        ) : null}
        <div className="mcp-create__footer">
          <Button disabled={busy || !valid} type="submit" variant="default">
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
  onClose,
  store,
}: {
  readonly onClose: () => void
  readonly store: PluginStore
}) {
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const busy = view.mcpPending > 0
  let entries: readonly McpEntry[] = []
  let parseError: string | null = null
  if (text.trim() !== '') {
    try {
      entries = parseMcpImport(text)
    } catch (cause) {
      parseError = cause instanceof Error ? cause.message : '配置无法解析。'
    }
  }
  const save = () => {
    setError(null)
    try {
      const items = entries.filter((entry) => selected.has(entry.name))
      void store.addEnvironmentServers(items).then((saved) => {
        if (saved) {
          onClose()
        }
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
          placeholder={
            '{\n  "my-mcp-server": {\n    "type": "stdio",\n    "command": "",\n    "args": []\n  }\n}'
          }
          rows={12}
          spellCheck={false}
          value={text}
        />
      </label>
      <p className="mcp__muted">
        支持直接粘贴 {'{"server-name": {...}}'} 或 {'{"mcpServers": {"server-name": {...}}}'}。
      </p>
      {parseError ? (
        <p className="mcp__error" role="alert">
          {parseError}
        </p>
      ) : null}
      {entries.length > 0 ? (
        <fieldset className="mcp__checks" disabled={busy}>
          <legend className="mcp__muted">
            选择要导入的服务器（{selected.size}/{entries.length}）
          </legend>
          <label className="mcp__check">
            <input
              checked={selected.size === entries.length}
              onChange={(event) =>
                setSelected(new Set(event.target.checked ? entries.map((entry) => entry.name) : []))
              }
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
      ) : null}
      {error || view.mcpFailure ? (
        <p className="mcp__error" role="alert">
          {error ?? view.mcpFailure}
        </p>
      ) : null}
      <div className="mcp-create__footer">
        <Button
          disabled={busy || selected.size === 0 || parseError !== null}
          onClick={save}
          type="button"
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
  const { body } = entry
  const [transport, setTransport] = useState(
    String(body['transport'] ?? (body['command'] === undefined ? 'http' : 'stdio')),
  )
  const [envOpen, setEnvOpen] = useState(true)
  const text = (key: string) =>
    typeof body[key] === 'string' || typeof body[key] === 'number' ? String(body[key]) : ''
  const json = (key: string, fallback: unknown) => JSON.stringify(body[key] ?? fallback, null, 2)
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
      <label className="mcp-field mcp-field--narrow">
        <span className="mcp__muted">类型</span>
        <select
          name="transport"
          onChange={(event) => setTransport(event.target.value)}
          value={transport}
        >
          <option value="stdio">stdio（本地命令）</option>
          <option value="http">HTTP（远程）</option>
          <option value="sse">SSE</option>
        </select>
      </label>
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
      <label className="mcp-field mcp-field--narrow">
        <span className="mcp__muted">协议版本</span>
        <select
          aria-label="协议版本（由 Agent 自动协商）"
          disabled
          name="protocolVersion"
          value="auto"
        >
          <option value="auto">自动（推荐）</option>
        </select>
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
            <input
              defaultValue={text('url')}
              name="url"
              placeholder="https://example.com/mcp"
              required
              type="url"
            />
          </label>
          <label className="mcp-field">
            <span className="mcp__muted">令牌环境变量名（可选）</span>
            <input
              defaultValue={text('bearerTokenEnvVar')}
              name="bearerTokenEnvVar"
              placeholder="MCP_TOKEN"
            />
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
          <span
            className={envOpen ? 'mcp-form__chevron mcp-form__chevron--open' : 'mcp-form__chevron'}
          >
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
      <p className="mcp__muted">
        环境变量和请求头中的值会明文保存到 Agent 的 mcp.json。远程令牌优先填写 bearerTokenEnvVar
        环境变量名；不要粘贴不必要的密钥。
      </p>
    </div>
  )
}
