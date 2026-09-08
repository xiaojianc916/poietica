import { Button, ConfirmationDialog, Dialog, Switch } from '@poietica/design-system'
import { type FormEvent, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { builtinServerRows, groupRows, matches } from '../catalog/listing'
import { type McpEntry, mcpEntryFromForm, parseMcpImport } from '../mcp-config'
import { describeOrigin } from '../origin'
import type { PluginStore } from '../plugin-store'
import { CatalogGrid } from './catalog-grid'
import './mcp-settings.css'

type Editor =
  | { readonly mode: 'form'; readonly entry: McpEntry }
  | { readonly mode: 'json'; readonly text: string }
const EMPTY_ENTRY: McpEntry = { name: '', body: { command: '', args: [] } }

export function McpSettings({ store }: { readonly store: PluginStore }) {
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [needle, setNeedle] = useState('')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const busy = view.mcpPending > 0
  useEffect(() => {
    store.refreshMcpServers()
  }, [store])
  const rows = view.mcpServers.filter((server) =>
    matches(needle, server.name, describeOrigin(server.origin)),
  )

  return (
    <section aria-label="MCP 服务器管理" className="mcp-settings">
      <div className="mcp-settings__toolbar">
        <span>用户配置 · MCP {view.mcpServers.length}</span>
        <input
          aria-label="搜索 MCP 服务器"
          onChange={(event) => setNeedle(event.target.value)}
          placeholder="搜索 MCP 服务器…"
          type="search"
          value={needle}
        />
      </div>
      <p className="mcp-settings__hint">
        配置位于本应用的 Agent 用户目录。启用表示允许装载，不代表连接成功；新增服务在新会话中可用。
      </p>
      {view.mcpFailure ? (
        <p className="mcp-settings__error" role="alert">
          {view.mcpFailure}
        </p>
      ) : null}
      <div className="mcp-settings__toolbar">
        <span>{busy ? '正在更新…' : '服务器配置'}</span>
        <div className="mcp-settings__actions">
          <Button disabled={busy} onClick={store.refreshMcpServers} type="button" variant="ghost">
            刷新
          </Button>
          <Button
            disabled={busy}
            onClick={() => setEditor({ mode: 'json', text: '' })}
            type="button"
            variant="outline"
          >
            导入 JSON
          </Button>
          <Button
            disabled={busy}
            onClick={() => setEditor({ mode: 'form', entry: EMPTY_ENTRY })}
            type="button"
          >
            ＋ 新建
          </Button>
        </div>
      </div>
      {!view.loaded ? (
        <p role="status">正在读取 MCP 配置…</p>
      ) : rows.length === 0 ? (
        <div className="mcp-settings__empty">
          <strong>
            {view.mcpFailure
              ? '无法确认服务器配置'
              : needle
                ? '没有匹配的 MCP 服务器'
                : '尚未配置 MCP 服务器'}
          </strong>
          <p>
            {needle ? '试试其他名称，或清空搜索。' : '手动新建服务器，或粘贴已有 JSON 配置导入。'}
          </p>
        </div>
      ) : (
        <ul className="mcp-settings__list">
          {rows.map((server) => (
            <li className="mcp-settings__row" key={JSON.stringify([server.origin, server.name])}>
              <div className="mcp-settings__copy">
                <strong>{server.name}</strong>
                <span>
                  {describeOrigin(server.origin)} ·{' '}
                  {!server.enabled
                    ? '已停用'
                    : server.launchedBy === 'none'
                      ? '插件已停用'
                      : '已启用 · 连接状态由会话确认'}
                </span>
              </div>
              <div className="mcp-settings__actions">
                {server.origin.kind === 'user' ? (
                  <Button
                    disabled={busy}
                    onClick={() => setRemoving(server.name)}
                    type="button"
                    variant="ghost"
                  >
                    删除
                  </Button>
                ) : null}
                <Switch
                  aria-label={`启用 ${server.name}`}
                  checked={server.enabled}
                  disabled={busy}
                  onCheckedChange={(enabled) =>
                    store.setMcpServerEnabled(server.origin, server.name, enabled)
                  }
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mcp-settings__hint">
        删除或停用后，已有会话的工具调用可能立即失效；不会把未探测的服务标为“已连接”。
      </p>
      <CatalogGrid
        action={{
          kind: 'server',
          install: store.installEnvironmentServer,
          resolveLauncher: store.resolveLauncher,
        }}
        groups={groupRows(builtinServerRows(view.mcpServers, needle))}
      />
      {editor === null ? null : (
        <McpEditor initial={editor} onClose={() => setEditor(null)} store={store} />
      )}
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

function McpEditor({
  initial,
  onClose,
  store,
}: {
  readonly initial: Editor
  readonly onClose: () => void
  readonly store: PluginStore
}) {
  const [editor, setEditor] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const form = useRef<HTMLFormElement>(null)
  const busy = view.mcpPending > 0
  let entries: readonly McpEntry[] = []
  let parseError: string | null = null
  if (editor.mode === 'json' && editor.text.trim() !== '') {
    try {
      entries = parseMcpImport(editor.text)
    } catch (cause) {
      parseError = cause instanceof Error ? cause.message : '配置无法解析。'
    }
  }
  const readForm = (validate = true): McpEntry => {
    if (form.current === null || editor.mode !== 'form') {
      throw new Error('表单未就绪。')
    }
    const fields: Record<string, string> = {}
    for (const [name, value] of new FormData(form.current)) {
      if (typeof value === 'string') {
        fields[name] = value
      }
    }
    return mcpEntryFromForm(fields, editor.entry.body, validate)
  }
  const act = (operation: () => void) => {
    setError(null)
    try {
      operation()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '配置无效。')
    }
  }
  const save = (items: readonly McpEntry[]) => {
    void store.addEnvironmentServers(items).then((saved) => {
      if (saved) {
        onClose()
      }
    })
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!busy) {
      act(() => save([readForm()]))
    }
  }

  return (
    <Dialog
      busy={busy}
      className="mcp-settings__dialog"
      closeOnOverlayClick={false}
      description="作用域：本应用的 Agent 用户配置。保存前请确认命令或地址可信。"
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
      open
      title="新建 MCP 服务器"
    >
      <div className="mcp-settings mcp-settings__editor">
        <div className="mcp-settings__actions">
          <Button
            aria-pressed={editor.mode === 'form'}
            disabled={
              busy || (editor.mode === 'json' && (entries.length !== 1 || parseError !== null))
            }
            onClick={() =>
              act(() => {
                const entry = entries[0]
                if (entry !== undefined) {
                  setEditor({ mode: 'form', entry })
                }
              })
            }
            type="button"
            variant="soft"
          >
            表单
          </Button>
          <Button
            aria-pressed={editor.mode === 'json'}
            disabled={busy}
            onClick={() =>
              act(() => {
                if (editor.mode === 'form') {
                  const entry = readForm(false)
                  setSelected(new Set([entry.name]))
                  setEditor({
                    mode: 'json',
                    text: JSON.stringify({ [entry.name]: entry.body }, null, 2),
                  })
                }
              })
            }
            type="button"
            variant="soft"
          >
            JSON
          </Button>
        </div>
        {editor.mode === 'form' ? (
          <form onSubmit={submit} ref={form}>
            <fieldset disabled={busy}>
              <McpFields entry={editor.entry} />
              <div className="mcp-settings__actions mcp-settings__footer">
                <Button disabled={busy} onClick={onClose} type="button" variant="ghost">
                  取消
                </Button>
                <Button disabled={busy} type="submit">
                  {busy ? '保存中…' : '保存'}
                </Button>
              </div>
            </fieldset>
          </form>
        ) : (
          <JsonImportPanel
            busy={busy}
            editor={editor}
            entries={entries}
            onCancel={onClose}
            onChange={(text) => {
              setEditor({ mode: 'json', text })
              setSelected(new Set())
              setError(null)
            }}
            onSave={(items) => act(() => save(items))}
            parseError={parseError}
            selected={selected}
            setSelected={setSelected}
          />
        )}
        <p className="mcp-settings__hint">
          环境变量和请求头中的值会明文保存到 Agent 的 mcp.json。远程令牌优先填写 bearerTokenEnvVar
          环境变量名；不要在配置中粘贴不必要的密钥。
        </p>
        {error || view.mcpFailure ? (
          <p className="mcp-settings__error" role="alert">
            {error ?? view.mcpFailure}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}

function JsonImportPanel({
  busy,
  editor,
  entries,
  onCancel,
  onChange,
  onSave,
  parseError,
  selected,
  setSelected,
}: {
  readonly busy: boolean
  readonly editor: Extract<Editor, { mode: 'json' }>
  readonly entries: readonly McpEntry[]
  readonly onCancel: () => void
  readonly onChange: (text: string) => void
  readonly onSave: (items: readonly McpEntry[]) => void
  readonly parseError: string | null
  readonly selected: ReadonlySet<string>
  readonly setSelected: (selected: ReadonlySet<string>) => void
}) {
  return (
    <>
      <label>
        完整配置
        <textarea
          autoComplete="off"
          disabled={busy}
          onChange={(event) => onChange(event.target.value)}
          placeholder={'{"mcpServers":{"example":{"url":"https://example.com/mcp"}}}'}
          rows={9}
          spellCheck={false}
          value={editor.text}
        />
      </label>
      <p className="mcp-settings__hint">
        支持名称映射或 mcpServers 包装。这里只导入你选择的
        JSON，不自动扫描其他应用；同名配置不会被覆盖。
      </p>
      {parseError ? (
        <p className="mcp-settings__error" role="alert">
          {parseError}
        </p>
      ) : null}
      {entries.length > 0 ? (
        <fieldset disabled={busy}>
          <legend>
            选择要导入的服务器（{selected.size}/{entries.length}）
          </legend>
          <label className="mcp-settings__check">
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
            <label className="mcp-settings__check" key={entry.name}>
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
      <div className="mcp-settings__actions mcp-settings__footer">
        <Button disabled={busy} onClick={onCancel} type="button" variant="ghost">
          取消
        </Button>
        <Button
          disabled={busy || selected.size === 0 || parseError !== null}
          onClick={() => onSave(entries.filter((entry) => selected.has(entry.name)))}
          type="button"
        >
          {busy ? '保存中…' : '导入所选'}
        </Button>
      </div>
    </>
  )
}

function McpFields({ entry }: { readonly entry: McpEntry }) {
  const { body } = entry
  const [transport, setTransport] = useState(
    String(body['transport'] ?? (body['command'] === undefined ? 'http' : 'stdio')),
  )
  const text = (key: string) =>
    typeof body[key] === 'string' || typeof body[key] === 'number' ? String(body[key]) : ''
  const json = (key: string, fallback: unknown) => JSON.stringify(body[key] ?? fallback, null, 2)
  return (
    <div className="mcp-settings__fields">
      <label>
        名称
        <input defaultValue={entry.name} name="name" placeholder="my-mcp-server" required />
      </label>
      <label>
        类型
        <select
          name="transport"
          onChange={(event) => setTransport(event.target.value)}
          value={transport}
        >
          <option value="stdio">stdio（本地命令）</option>
          <option value="http">HTTP（推荐远程方式）</option>
          <option value="sse">SSE</option>
        </select>
      </label>
      <label>
        连接超时（毫秒）
        <input
          defaultValue={text('startupTimeoutMs')}
          max={2147483647}
          min={1}
          name="startupTimeoutMs"
          placeholder="使用 Agent 默认值（通常 30000）"
          step={1}
          type="number"
        />
      </label>
      <p className="mcp-settings__hint">协议版本由 Agent 自动协商，无需手动设置。</p>
      <fieldset disabled={transport !== 'stdio'} hidden={transport !== 'stdio'}>
        <label>
          命令
          <input
            defaultValue={text('command')}
            name="command"
            placeholder="npx"
            required={transport === 'stdio'}
          />
        </label>
        <label>
          参数（JSON 字符串数组）
          <textarea defaultValue={json('args', [])} name="args" rows={3} spellCheck={false} />
        </label>
        <label>
          工作目录（可选）
          <input defaultValue={text('cwd')} name="cwd" />
        </label>
        <label>
          环境变量（JSON，可选）
          <textarea
            autoComplete="off"
            defaultValue={json('env', {})}
            name="env"
            rows={3}
            spellCheck={false}
          />
        </label>
      </fieldset>
      <fieldset disabled={transport === 'stdio'} hidden={transport === 'stdio'}>
        <label>
          服务器 URL
          <input
            defaultValue={text('url')}
            name="url"
            placeholder="https://example.com/mcp"
            required={transport !== 'stdio'}
            type="url"
          />
        </label>
        <label>
          令牌环境变量名（可选）
          <input
            defaultValue={text('bearerTokenEnvVar')}
            name="bearerTokenEnvVar"
            placeholder="MCP_TOKEN"
          />
        </label>
        <label>
          请求头（JSON，可选）
          <textarea
            autoComplete="off"
            defaultValue={json('headers', {})}
            name="headers"
            rows={3}
            spellCheck={false}
          />
        </label>
      </fieldset>
    </div>
  )
}
