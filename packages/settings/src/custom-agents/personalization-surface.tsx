import { Button, Select, type SelectOption } from '@poietica/ui'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import { type ReactNode, useEffect, useSyncExternalStore } from 'react'
import type { CustomAgentDraft, DelegationMode, ModelPreference, ToolMode } from './agent-document'
import type { PersonalizationStore } from './personalization-store'
import './personalization-surface.css'

const TOOL_MODES: readonly SelectOption<ToolMode>[] = [
  { value: 'all', label: '全部工具' },
  { value: 'allowlist', label: '仅白名单' },
  { value: 'none', label: '不提供工具' },
]

const DELEGATION_MODES: readonly SelectOption<DelegationMode>[] = [
  { value: 'default', label: '继承默认' },
  { value: 'all', label: '全部 Agent' },
  { value: 'allowlist', label: '仅指定 Agent' },
  { value: 'none', label: '禁止继续委派' },
]

/* 与 Kimi 的 agent-file 解析器同义：model_preference 只认 primary / secondary。 */
const MODEL_PREFERENCES: readonly SelectOption<ModelPreference>[] = [
  { value: 'session', label: '跟随会话' },
  { value: 'primary', label: '主模型' },
  { value: 'secondary', label: '副模型' },
]

export interface PersonalizationSurfaceProps {
  readonly store: PersonalizationStore
}

/**
 * 侧边栏「个性化」那一格。纯投影：所有状态与写路径都在 PersonalizationStore。
 */
export function PersonalizationSurface({ store }: PersonalizationSurfaceProps) {
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  useEffect(store.load, [])

  const { busy, draft } = view
  const savable = busy === null && view.isDirty && view.validation === null

  return (
    <section aria-label="个性化" className="personalization">
      <header className="personalization__head">
        <div>
          <h1>自定义 Agent</h1>

          <p>
            写入受控 Kimi agents 目录。主代理在新会话中自动发现它们，并按「触发场景」决定何时委派。
          </p>
        </div>

        <div className="personalization__head-actions">
          <Button
            disabled={busy !== null}
            onClick={store.refresh}
            size="xs"
            type="button"
            variant="outline"
          >
            <RefreshCw aria-hidden="true" size={14} /> 刷新
          </Button>

          <Button onClick={store.startNew} size="xs" type="button" variant="soft">
            <Plus aria-hidden="true" size={14} /> 新建
          </Button>
        </div>
      </header>

      {view.failure === null ? null : (
        <p className="personalization__alert" role="alert">
          {view.failure}
        </p>
      )}

      <div className="personalization__body">
        <nav aria-label="自定义 Agent 列表" className="personalization__rail">
          {view.entries.map((entry) => (
            <button
              aria-current={entry.isSelected ? 'true' : undefined}
              className="personalization__row"
              data-selected={entry.isSelected ? 'true' : 'false'}
              key={entry.relativePath}
              onClick={() => {
                store.select(entry.relativePath)
              }}
              type="button"
            >
              <span className="personalization__row-name">{entry.name}</span>

              <span
                aria-hidden="true"
                className="personalization__dot"
                data-broken={entry.isBroken ? 'true' : 'false'}
                data-visible={entry.isDirty || entry.isBroken ? 'true' : 'false'}
              />

              <span className="personalization__row-hint">{entry.description}</span>

              {entry.isDirty ? <span className="personalization__sr">尚未保存</span> : null}
              {entry.isBroken ? <span className="personalization__sr">无法解析</span> : null}
            </button>
          ))}

          {view.issues.map((issue) => (
            <p className="personalization__issue" key={issue}>
              {issue}
            </p>
          ))}
        </nav>

        <form
          className="personalization__editor"
          onSubmit={(event) => {
            event.preventDefault()
          }}
        >
          <div className="personalization__fields">
            <Field hint="kebab-case，作为 Agent 类型标识" label="名称">
              <input
                onChange={(event) => store.edit({ name: event.target.value })}
                value={draft.name}
              />
            </Field>

            <Field hint="主代理何时应委派给它" label="触发场景">
              <input
                onChange={(event) => store.edit({ whenToUse: event.target.value })}
                value={draft.whenToUse}
              />
            </Field>

            <Field hint="参与主代理的委派决策，必须具体" label="任务描述" wide>
              <input
                onChange={(event) => store.edit({ description: event.target.value })}
                value={draft.description}
              />
            </Field>

            <Field hint="不填白名单时为全部工具" label="工具策略">
              <Select
                data={TOOL_MODES}
                onValueChange={(toolMode) => store.edit({ toolMode })}
                type="工具策略"
                value={draft.toolMode}
              />
            </Field>

            <Field hint="显式列表可形成受控嵌套链" label="委派策略">
              <Select
                data={DELEGATION_MODES}
                onValueChange={(delegationMode) => store.edit({ delegationMode })}
                type="委派策略"
                value={draft.delegationMode}
              />
            </Field>

            <Field hint="写入 model_preference；跟随会话则不写这一行" label="模型偏好">
              <Select
                data={MODEL_PREFERENCES}
                onValueChange={(modelPreference) => store.edit({ modelPreference })}
                type="模型偏好"
                value={draft.modelPreference}
              />
            </Field>

            {draft.toolMode === 'allowlist' ? (
              <Field hint="逗号分隔；MCP 可用 mcp__server__*" label="工具白名单">
                <input
                  onChange={(event) => store.edit({ tools: event.target.value })}
                  value={draft.tools}
                />
              </Field>
            ) : null}

            <Field hint="在白名单之后应用；例如 Bash" label="工具黑名单">
              <input
                onChange={(event) => store.edit({ disallowedTools: event.target.value })}
                value={draft.disallowedTools}
              />
            </Field>

            {draft.delegationMode === 'allowlist' ? (
              <Field hint="逗号分隔；派发前由 Kimi 再校验一次" label="可委派 Agent">
                <input
                  onChange={(event) => store.edit({ subagents: event.target.value })}
                  value={draft.subagents}
                />
              </Field>
            ) : null}

            <label className="personalization__check">
              <input
                checked={draft.override}
                onChange={(event) => store.edit({ override: event.target.checked })}
                type="checkbox"
              />

              <span>
                <strong>允许覆盖同名内置 Agent</strong>
                <small>只在明确替换 coder / explore / plan 等内置类型时开启</small>
              </span>
            </label>

            <Field hint="最后一条消息应是交给调用方的完整、自包含结果" label="System prompt" wide>
              <textarea
                onChange={(event) => store.edit({ prompt: event.target.value })}
                rows={14}
                value={draft.prompt}
              />
            </Field>
          </div>

          <footer className="personalization__footer">
            <div className="personalization__status">
              {view.isRemovalArmed ? (
                <span className="personalization__warning">删除后无法撤销。</span>
              ) : view.isDirty && view.validation !== null ? (
                <span className="personalization__validation">{view.validation}</span>
              ) : view.absolutePath !== null ? (
                <>
                  <span>作为主代理启动</span>
                  <code>kimi --agent-file &quot;{view.absolutePath}&quot;</code>
                </>
              ) : (
                <span>保存后写入受控 Kimi agents 目录。</span>
              )}
            </div>

            <div className="personalization__footer-actions">
              {view.isNew ? null : view.isRemovalArmed ? (
                <>
                  <Button
                    disabled={busy !== null}
                    onClick={() => {
                      void store.remove()
                    }}
                    size="xs"
                    type="button"
                    variant="soft"
                  >
                    确认删除
                  </Button>

                  <Button onClick={store.disarmRemoval} size="xs" type="button" variant="outline">
                    取消
                  </Button>
                </>
              ) : (
                <Button
                  disabled={busy !== null}
                  onClick={store.armRemoval}
                  size="xs"
                  type="button"
                  variant="outline"
                >
                  <Trash2 aria-hidden="true" size={14} /> 删除
                </Button>
              )}

              <Button
                disabled={!savable}
                onClick={() => {
                  void store.save()
                }}
                size="xs"
                type="button"
                variant="soft"
              >
                {busy === 'save' ? '保存中…' : '保存'}
              </Button>
            </div>
          </footer>
        </form>
      </div>
    </section>
  )
}

interface FieldProps {
  readonly label: string
  readonly hint: string
  readonly wide?: boolean
  readonly children: ReactNode
}

function Field({ label, hint, wide = false, children }: FieldProps) {
  return (
    <label
      className={
        wide ? 'personalization__field personalization__field--wide' : 'personalization__field'
      }
    >
      <span>
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>

      {children}
    </label>
  )
}

export type { CustomAgentDraft }
