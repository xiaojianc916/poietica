import { Button } from '@poietica/ui'
import { Bot, Network, Plus, RefreshCw, Save, ShieldCheck, Trash2, Workflow } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import {
  type CustomAgentDraft,
  emptyAgentDraft,
  parseAgentDocument,
  serializeAgentDocument,
  validateAgentDraft,
} from './agent-document'
import type { CustomAgentCatalog, CustomAgentFile, CustomAgentStore } from './custom-agent-store'
import './personalization-settings.css'

export interface PersonalizationSettingsProps {
  readonly store: CustomAgentStore
}

export function PersonalizationSettings({ store }: PersonalizationSettingsProps) {
  const [catalog, setCatalog] = useState<CustomAgentCatalog>({ files: [], issues: [] })
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [absolutePath, setAbsolutePath] = useState('')
  const [baseline, setBaseline] = useState('')
  const [draft, setDraft] = useState<CustomAgentDraft | null>(null)
  const [busy, setBusy] = useState<'load' | 'save' | 'remove' | null>('load')
  const [message, setMessage] = useState<string | null>(null)

  const document = useMemo(() => (draft ? serializeAgentDocument(draft) : ''), [draft])
  const dirty = draft !== null && document !== baseline
  const validation = draft ? validateAgentDraft(draft) : null

  useEffect(() => {
    let active = true
    void store.load().then(
      (next) => {
        if (!active) {
          return
        }
        setCatalog(next)
        setBusy(null)
        if (next.files[0]) {
          openFile(next.files[0], false)
        } else {
          setDraft(emptyAgentDraft())
        }
      },
      (cause: unknown) => {
        if (!active) {
          return
        }
        setMessage(messageOf(cause))
        setBusy(null)
      },
    )
    return () => {
      active = false
    }
  }, [store, openFile])

  function update(patch: Partial<CustomAgentDraft>) {
    setDraft((current) => (current ? { ...current, ...patch } : current))
  }

  function openFile(file: CustomAgentFile, ask = true) {
    if (ask && dirty && !window.confirm('放弃尚未保存的修改？')) {
      return
    }
    try {
      setDraft(parseAgentDocument(file.relativePath, file.document))
      setSelectedPath(file.relativePath)
      setAbsolutePath(file.absolutePath)
      setBaseline(file.document)
      setMessage(null)
    } catch (cause: unknown) {
      setMessage(`${file.relativePath}：${messageOf(cause)}`)
    }
  }

  async function reload(target = selectedPath) {
    if (dirty && !window.confirm('刷新会丢弃尚未保存的修改，继续？')) {
      return
    }
    setBusy('load')
    setMessage(null)
    try {
      const next = await store.load()
      setCatalog(next)
      const file = next.files.find((item) => item.relativePath === target) ?? next.files[0]
      if (file) {
        openFile(file, false)
      } else {
        setSelectedPath(null)
        setAbsolutePath('')
        setBaseline('')
        setDraft(emptyAgentDraft())
      }
    } catch (cause: unknown) {
      setMessage(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  function createAgent() {
    if (dirty && !window.confirm('放弃尚未保存的修改？')) {
      return
    }
    setSelectedPath(null)
    setAbsolutePath('')
    setBaseline('')
    setDraft(emptyAgentDraft())
    setMessage(null)
  }

  async function save() {
    if (!draft || validation) {
      return
    }
    setBusy('save')
    setMessage(null)
    const relativePath = selectedPath ?? `${draft.name.trim()}.md`
    try {
      const saved = await store.save({
        relativePath,
        document,
        expectedDocument: selectedPath === null ? null : baseline,
      })
      const next = await store.load()
      setCatalog(next)
      openFile(saved, false)
      setMessage('已保存；Kimi Code 会在新会话中自动发现该 Agent。')
    } catch (cause: unknown) {
      setMessage(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  async function remove() {
    if (!selectedPath || !window.confirm('删除这个自定义 Agent 文件？此操作不可撤销。')) {
      return
    }
    setBusy('remove')
    setMessage(null)
    try {
      await store.remove({ relativePath: selectedPath, expectedDocument: baseline })
      const next = await store.load()
      setCatalog(next)
      const file = next.files[0]
      if (file) {
        openFile(file, false)
      } else {
        createAgent()
      }
    } catch (cause: unknown) {
      setMessage(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="personalization">
      <div aria-label="Kimi Code 自定义 Agent 能力" className="personalization__capabilities">
        <Capability icon={Bot} label="自动发现" value="用户与项目 agents 目录" />
        <Capability icon={Workflow} label="主代理启动" value="--agent-file" />
        <Capability icon={Network} label="嵌套委派" value="subagents 门禁" />
        <Capability icon={ShieldCheck} label="执行边界" value="工具白名单 + 黑名单" />
      </div>

      <div className="personalization__notice">
        <strong>模型继承当前会话</strong>
        <span>Kimi Code v2 的 Agent 文件当前不消费独立 model 字段，因此这里不提供无效选择器。</span>
      </div>

      <div className="personalization__workspace">
        <aside aria-label="自定义 Agent" className="personalization__list">
          <div className="personalization__list-actions">
            <Button onClick={createAgent} size="xs" type="button" variant="soft">
              <Plus aria-hidden="true" size={14} /> 新建
            </Button>
            <Button
              disabled={busy !== null}
              onClick={() => void reload()}
              size="xs"
              type="button"
              variant="outline"
            >
              <RefreshCw aria-hidden="true" size={14} /> 刷新
            </Button>
          </div>
          <div className="personalization__files">
            {catalog.files.map((file) => {
              let name = file.relativePath.replace(/.md$/, '')
              let description = '无法读取描述'
              try {
                const parsed = parseAgentDocument(file.relativePath, file.document)
                name = parsed.name
                description = parsed.description
              } catch {
                description = '文件格式无效'
              }
              return (
                <button
                  aria-current={selectedPath === file.relativePath ? 'true' : undefined}
                  className="personalization__file"
                  data-active={selectedPath === file.relativePath ? 'true' : 'false'}
                  key={file.relativePath}
                  onClick={() => openFile(file)}
                  type="button"
                >
                  <strong>{name}</strong>
                  <span>{description}</span>
                </button>
              )
            })}
          </div>
          {catalog.issues.length > 0 ? (
            <div className="personalization__issues" role="status">
              {catalog.issues.map((issue) => (
                <p key={issue}>{issue}</p>
              ))}
            </div>
          ) : null}
        </aside>

        <div className="personalization__editor">
          {draft ? (
            <>
              <div className="personalization__editor-head">
                <div>
                  <strong>{selectedPath ? draft.name || selectedPath : '新自定义 Agent'}</strong>
                  <span>{selectedPath ?? '保存后写入受控 Kimi agents 目录'}</span>
                </div>
                <div className="personalization__editor-actions">
                  {selectedPath ? (
                    <Button
                      disabled={busy !== null}
                      onClick={() => void remove()}
                      size="xs"
                      type="button"
                      variant="outline"
                    >
                      <Trash2 aria-hidden="true" size={14} /> 删除
                    </Button>
                  ) : null}
                  <Button
                    disabled={busy !== null || !dirty || validation !== null}
                    onClick={() => void save()}
                    size="xs"
                    type="button"
                    variant="soft"
                  >
                    <Save aria-hidden="true" size={14} /> {busy === 'save' ? '保存中…' : '保存'}
                  </Button>
                </div>
              </div>

              <div className="personalization__grid">
                <Field hint="kebab-case；作为 Agent 类型标识" label="名称">
                  <input
                    onChange={(event) => update({ name: event.target.value })}
                    value={draft.name}
                  />
                </Field>
                <Field hint="主代理何时应委派给它" label="触发场景">
                  <input
                    onChange={(event) => update({ whenToUse: event.target.value })}
                    value={draft.whenToUse}
                  />
                </Field>
              </div>

              <Field hint="参与主代理的委派决策，必须具体" label="任务描述">
                <input
                  onChange={(event) => update({ description: event.target.value })}
                  value={draft.description}
                />
              </Field>

              <div className="personalization__grid">
                <Field hint="不填白名单时为全部工具" label="工具策略">
                  <select
                    onChange={(event) =>
                      update({ toolMode: event.target.value as CustomAgentDraft['toolMode'] })
                    }
                    value={draft.toolMode}
                  >
                    <option value="all">全部工具</option>
                    <option value="allowlist">仅白名单</option>
                    <option value="none">不提供工具</option>
                  </select>
                </Field>
                <Field hint="显式列表可形成受控嵌套链" label="委派策略">
                  <select
                    onChange={(event) =>
                      update({
                        delegationMode: event.target.value as CustomAgentDraft['delegationMode'],
                      })
                    }
                    value={draft.delegationMode}
                  >
                    <option value="default">继承默认</option>
                    <option value="all">全部 Agent</option>
                    <option value="allowlist">仅指定 Agent</option>
                    <option value="none">禁止继续委派</option>
                  </select>
                </Field>
              </div>

              {draft.toolMode === 'allowlist' ? (
                <Field hint="逗号分隔；MCP 可用 mcp__server__*" label="工具白名单">
                  <input
                    onChange={(event) => update({ tools: event.target.value })}
                    value={draft.tools}
                  />
                </Field>
              ) : null}
              <Field hint="在白名单之后应用；例如 Bash" label="工具黑名单">
                <input
                  onChange={(event) => update({ disallowedTools: event.target.value })}
                  value={draft.disallowedTools}
                />
              </Field>
              {draft.delegationMode === 'allowlist' ? (
                <Field hint="逗号分隔；由 Kimi 在派发前再次强制校验" label="可委派 Agent">
                  <input
                    onChange={(event) => update({ subagents: event.target.value })}
                    value={draft.subagents}
                  />
                </Field>
              ) : null}

              <label className="personalization__check">
                <input
                  checked={draft.override}
                  onChange={(event) => update({ override: event.target.checked })}
                  type="checkbox"
                />
                <span>
                  <strong>允许覆盖同名内置 Agent</strong>
                  <small>只在明确替换 coder / explore / plan 等内置类型时开启</small>
                </span>
              </label>

              <Field hint="最后一条消息应是交给调用方的完整、自包含结果" label="System prompt">
                <textarea
                  onChange={(event) => update({ prompt: event.target.value })}
                  rows={13}
                  value={draft.prompt}
                />
              </Field>

              {absolutePath ? (
                <div className="personalization__command">
                  <span>作为主代理启动</span>
                  <code>kimi --agent-file &quot;{absolutePath}&quot;</code>
                </div>
              ) : null}
              {validation || message ? (
                <p className="personalization__message" role="status">
                  {validation ?? message}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </section>
  )
}

function Capability({
  icon: Icon,
  label,
  value,
}: {
  readonly icon: typeof Bot
  readonly label: string
  readonly value: string
}) {
  return (
    <div>
      <Icon aria-hidden="true" size={16} />
      <span>
        <strong>{label}</strong>
        <small>{value}</small>
      </span>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string
  readonly hint: string
  readonly children: ReactNode
}) {
  return (
    <label className="personalization__field">
      <span>
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
      {children}
    </label>
  )
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : '操作失败'
}
