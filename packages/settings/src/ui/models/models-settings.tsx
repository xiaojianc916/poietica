import { agent } from '@poietica/agent-catalog'
import {
  Button,
  ConfirmationDialog,
  InlineSpinner,
  SearchableSelect,
  Select,
  type SelectOption,
  Switch,
} from '@poietica/design-system'
import { Box, Eye, EyeOff, Pencil, Plus, RotateCw, SlidersHorizontal, Trash2 } from 'lucide-react'
import { Reorder } from 'motion/react'
import {
  type ComponentProps,
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  type AgentSettings,
  type CatalogProvider,
  type ModelCatalogData,
  type ModelCatalogOperation,
  type ModelCatalogStore,
  type ModelDescriptor,
  type ModelProvider,
  modelAlias,
  type ProviderModelInput,
} from '../../index'
import { describeAgentCliFailure } from '../agent-install/agent-cli-text'
import { AgentInstallAction } from '../agent-install/agent-install-action'
import './models-settings.css'

/*
 * 「模型」设置页：已配置模型的可见性清单，与供应商工作区（轨道 + 新建/编辑表单）。
 *
 * 不拆（1147 行）：所有子组件共享 ModelCatalogPanel 的 run 通道与同一套错误
 * 文案；表单的草稿类型、校验与提交构造（validateModels/saveProvider）是同一张
 * 表单的两半，拆开就得导出一串只为彼此存在的中间类型。
 */

const COLLAPSED_MODEL_LIMIT = 8
const NEW_PROVIDER = '__new_provider__'
const CUSTOM_PROVIDER = '__custom_provider__'
const PROVIDER_TYPES: SelectOption[] = [
  { value: 'openai', label: 'OpenAI Chat' },
  { value: 'openai_responses', label: 'OpenAI Responses' },
  { value: 'anthropic', label: 'Anthropic Messages (/v1/messages)' },
  { value: 'kimi', label: 'Kimi' },
  { value: 'google-genai', label: 'Google GenAI' },
  { value: 'vertexai', label: 'Vertex AI' },
]
const TOKEN_FORMAT = new Intl.NumberFormat('zh-CN')
type Mutation = Exclude<ModelCatalogOperation, { readonly kind: 'snapshot' }>
type RunMutation = (operation: Mutation) => Promise<boolean>

export interface ModelsSettingsProps {
  readonly store: AgentSettings
  readonly modelCatalog: ModelCatalogStore
  readonly hiddenModelAliases: readonly string[]
  readonly providerOrder: readonly string[]
  readonly onModelVisibilityChange: (modelId: string, visible: boolean) => void
  readonly onProviderOrderChange: (providerIds: readonly string[]) => void
}

export function ModelsSettings({
  store,
  modelCatalog,
  hiddenModelAliases,
  providerOrder,
  onModelVisibilityChange,
  onProviderOrderChange,
}: ModelsSettingsProps) {
  const [agentError, setAgentError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void store.load().then(
      (snapshot) =>
        active && setAgentError(snapshot.issues.length > 0 ? snapshot.issues.join('；') : null),
      (cause: unknown) =>
        active && setAgentError(describeAgentCliFailure(cause, 'agent 配置读取失败，请重试。')),
    )
    return () => {
      active = false
    }
  }, [store])

  return (
    <section className="models-page">
      <div className="models-block">
        <span className="models-block__label">智能体</span>
        <div className="models-card">
          <div className="models-row">
            <div className="models-row__copy">
              <strong>{agent.displayName}</strong>
              <p>{agentError ?? '本软件的对话由它提供，可用模型与密钥都归它'}</p>
            </div>
            <AgentInstallAction agentId={agent.id} store={store} />
          </div>
        </div>
      </div>
      <ModelCatalogPanel
        hiddenModelAliases={hiddenModelAliases}
        onModelVisibilityChange={onModelVisibilityChange}
        onProviderOrderChange={onProviderOrderChange}
        providerOrder={providerOrder}
        store={modelCatalog}
      />
    </section>
  )
}

function ModelCatalogPanel({
  store,
  hiddenModelAliases,
  providerOrder,
  onModelVisibilityChange,
  onProviderOrderChange,
}: {
  readonly store: ModelCatalogStore
  readonly hiddenModelAliases: readonly string[]
  readonly providerOrder: readonly string[]
  readonly onModelVisibilityChange: (modelId: string, visible: boolean) => void
  readonly onProviderOrderChange: (providerIds: readonly string[]) => void
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [actionError, setActionError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  useEffect(() => {
    void store.load()
  }, [store])

  const run: RunMutation = async (operation) => {
    setActionError(null)
    try {
      await store.mutate(operation)
      return true
    } catch (cause) {
      setActionError(describeAgentCliFailure(cause, '模型配置写入失败，请重试。'))
      return false
    }
  }

  if (snapshot.data === null) {
    if (snapshot.error !== null) {
      return (
        <p className="models-notice models-notice--bar">
          <span>{snapshot.error}</span>
          <Button onClick={() => void store.refresh()} size="xs" type="button" variant="soft">
            重试
          </Button>
        </p>
      )
    }
    return <p className="models-empty">正在读取模型配置…</p>
  }

  return (
    <>
      {actionError === null ? null : <p className="models-notice">{actionError}</p>}
      <ConfiguredModels
        data={snapshot.data}
        hiddenModelAliases={hiddenModelAliases}
        loading={snapshot.loading || snapshot.mutating}
        onModelVisibilityChange={onModelVisibilityChange}
        onRefresh={() => {
          setActionError(null)
          void store.refreshFromSources().catch((cause: unknown) => {
            setActionError(describeAgentCliFailure(cause, '模型元数据刷新失败，请重试。'))
          })
        }}
      />
      <ProviderWorkspace
        data={snapshot.data}
        disabled={snapshot.mutating}
        onModelVisibilityChange={onModelVisibilityChange}
        onProviderOrderChange={onProviderOrderChange}
        onRemove={setRemoving}
        onRun={run}
        providerOrder={providerOrder}
      />
      <ConfirmationDialog
        busy={snapshot.mutating}
        confirmLabel="删除"
        description={`删除 ${removing ?? ''} 后，它的模型与密钥一起从 agent 配置里移除。`}
        destructive
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const providerId = removing
          setRemoving(null)
          if (providerId !== null) {
            void run({ kind: 'delete', providerId })
          }
        }}
        open={removing !== null}
        title="删除这个服务商？"
      />
    </>
  )
}

function ConfiguredModels({
  data,
  loading,
  onRefresh,
  hiddenModelAliases,
  onModelVisibilityChange,
}: {
  readonly data: ModelCatalogData
  readonly loading: boolean
  readonly onRefresh: () => void
  readonly hiddenModelAliases: readonly string[]
  readonly onModelVisibilityChange: (modelId: string, visible: boolean) => void
}) {
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)
  const hidden = useMemo(() => new Set(hiddenModelAliases), [hiddenModelAliases])
  const models = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matched =
      needle === ''
        ? data.models
        : data.models.filter(
            (model) =>
              (model.displayName ?? model.model).toLowerCase().includes(needle) ||
              model.model.toLowerCase().includes(needle) ||
              model.provider.toLowerCase().includes(needle),
          )
    return showAll || needle !== '' ? matched : matched.slice(0, COLLAPSED_MODEL_LIMIT)
  }, [data.models, query, showAll])

  return (
    <div className="models-block">
      <span className="models-block__label">已配置的模型</span>
      <div className="models-card models-card--list">
        <div className="models-toolbar">
          <input
            aria-label="搜索已配置模型"
            className="models-input"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索模型"
            type="search"
            value={query}
          />
          <button
            aria-label="从模型来源刷新元数据"
            className="models-icon-button"
            disabled={loading}
            onClick={onRefresh}
            type="button"
          >
            <RotateCw aria-hidden="true" size={16} strokeWidth={1.7} />
          </button>
        </div>
        {models.length === 0 ? (
          <p className="models-empty">还没有已配置的模型。</p>
        ) : (
          <div className="models-list">
            {models.map((model) => (
              <ConfiguredModel
                key={model.model}
                model={model}
                onVisibleChange={(visible) => onModelVisibilityChange(model.model, visible)}
                visible={!hidden.has(model.model)}
              />
            ))}
          </div>
        )}
        {data.models.length > COLLAPSED_MODEL_LIMIT && query.trim() === '' ? (
          <button
            className="models-link"
            onClick={() => setShowAll((value) => !value)}
            type="button"
          >
            {showAll ? '收起模型列表' : '查看全部模型'}
          </button>
        ) : null}
      </div>
    </div>
  )
}

function ConfiguredModel({
  model,
  visible,
  onVisibleChange,
}: {
  readonly model: ModelDescriptor
  readonly visible: boolean
  readonly onVisibleChange: (visible: boolean) => void
}) {
  return (
    <div className="models-row models-row--compact">
      <div className="models-row__copy">
        <span className="models-row__name">{model.displayName ?? model.model}</span>
        <p>{`${model.model} · ${TOKEN_FORMAT.format(model.maxContextSize)} 上下文`}</p>
      </div>
      <Switch
        aria-label={`在输入框中显示 ${model.displayName ?? model.model}`}
        checked={visible}
        onCheckedChange={onVisibleChange}
        size="sm"
      />
    </div>
  )
}

function ProviderWorkspace({
  data,
  disabled,
  providerOrder,
  onModelVisibilityChange,
  onProviderOrderChange,
  onRemove,
  onRun,
}: {
  readonly data: ModelCatalogData
  readonly disabled: boolean
  readonly providerOrder: readonly string[]
  readonly onModelVisibilityChange: (modelId: string, visible: boolean) => void
  readonly onProviderOrderChange: (providerIds: readonly string[]) => void
  readonly onRemove: (providerId: string) => void
  readonly onRun: RunMutation
}) {
  const providers = useMemo(
    () => reconcileProviderOrder(data.providers, providerOrder),
    [data.providers, providerOrder],
  )
  const [selected, setSelected] = useState(providers[0]?.id ?? NEW_PROVIDER)
  useEffect(() => {
    if (selected !== NEW_PROVIDER && !providers.some((provider) => provider.id === selected)) {
      setSelected(providers[0]?.id ?? NEW_PROVIDER)
    }
  }, [providers, selected])
  const provider = providers.find((candidate) => candidate.id === selected)
  return (
    <div className="models-block">
      <span className="models-block__label">供应商</span>
      <div className="models-provider-workspace">
        <ProviderRail
          catalog={data.catalog}
          onOrderChange={onProviderOrderChange}
          onSelect={setSelected}
          providers={providers}
          selected={selected}
        />
        <section className="models-provider-editor">
          {provider === undefined ? (
            <NewProviderPanel
              data={data}
              disabled={disabled}
              onCreated={setSelected}
              onModelVisibilityChange={onModelVisibilityChange}
              onRun={onRun}
            />
          ) : (
            <ConfiguredProviderPanel
              data={data}
              disabled={disabled}
              key={provider.id}
              onRemove={() => onRemove(provider.id)}
              onRun={onRun}
              onSaved={setSelected}
              provider={provider}
            />
          )}
        </section>
      </div>
    </div>
  )
}

function reconcileProviderOrder(
  providers: readonly ModelProvider[],
  preferred: readonly string[],
): ModelProvider[] {
  const remaining = new Map(providers.map((provider) => [provider.id, provider]))
  const ordered: ModelProvider[] = []
  for (const id of preferred) {
    const provider = remaining.get(id)
    if (provider !== undefined) {
      ordered.push(provider)
      remaining.delete(id)
    }
  }
  for (const provider of providers) {
    if (remaining.delete(provider.id)) {
      ordered.push(provider)
    }
  }
  return ordered
}

function ProviderRail({
  providers,
  catalog,
  selected,
  onSelect,
  onOrderChange,
}: {
  readonly providers: readonly ModelProvider[]
  readonly catalog: readonly CatalogProvider[]
  readonly selected: string
  readonly onSelect: (id: string) => void
  readonly onOrderChange: (providerIds: readonly string[]) => void
}) {
  const ids = providers.map((provider) => provider.id)
  /* 分组只看 id 是否命中内置目录：改过名的归入自定义，不另记血缘。 */
  const catalogName = useMemo(
    () => new Map(catalog.map((entry) => [entry.id, entry.name])),
    [catalog],
  )
  const groups = useMemo(() => {
    const ordered: { readonly label: string; readonly items: ModelProvider[] }[] = []
    const byLabel = new Map<string, ModelProvider[]>()
    for (const provider of providers) {
      const label = catalogName.get(provider.id) ?? ''
      let items = byLabel.get(label)
      if (items === undefined) {
        items = []
        byLabel.set(label, items)
        ordered.push({ label, items })
      }
      items.push(provider)
    }
    return ordered
  }, [catalogName, providers])
  const move = (id: string, offset: -1 | 1) => {
    const from = ids.indexOf(id)
    const to = Math.max(0, Math.min(ids.length - 1, from + offset))

    if (from < 0 || from === to) {
      return
    }

    const next = [...ids]
    const [moved] = next.splice(from, 1)

    if (moved === undefined) {
      return
    }

    next.splice(to, 0, moved)
    onOrderChange(next)
  }
  /* 组内拖拽只重排本组：把新顺序缝回全局顺序的原位，别组不动。 */
  const reorderGroup = (groupIds: readonly string[], next: readonly string[]): void => {
    const group = new Set(groupIds)
    let index = 0
    onOrderChange(ids.map((id) => (group.has(id) ? (next[index++] ?? id) : id)))
  }

  return (
    <aside className="models-provider-rail">
      {providers.length === 0 ? (
        <span className="models-provider-rail__empty">还没有供应商</span>
      ) : (
        <div className="models-provider-rail__groups">
          {groups.map((group) => {
            const groupIds = group.items.map((provider) => provider.id)
            return (
              <div className="models-provider-group" key={group.label}>
                <span className="models-provider-rail__label">{group.label}</span>
                <Reorder.Group
                  aria-label={`${group.label}供应商顺序`}
                  as="nav"
                  axis="y"
                  className="models-provider-rail__list"
                  layoutScroll
                  onReorder={(next: string[]) => reorderGroup(groupIds, next)}
                  values={groupIds}
                >
                  {group.items.map((provider) => (
                    <Reorder.Item
                      as="div"
                      className="models-provider-order-item"
                      key={provider.id}
                      value={provider.id}
                      whileDrag={{ scale: 1.02 }}
                    >
                      <button
                        aria-current={selected === provider.id ? 'page' : undefined}
                        aria-label={`${provider.id}，拖动或按 Alt 加上下方向键排序`}
                        className="models-provider-item"
                        data-active={selected === provider.id}
                        onClick={() => onSelect(provider.id)}
                        onKeyDown={(event) => {
                          if (!event.altKey) {
                            return
                          }

                          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                            event.preventDefault()
                            move(provider.id, event.key === 'ArrowUp' ? -1 : 1)
                          }
                        }}
                        type="button"
                      >
                        <Box aria-hidden="true" className="models-provider-item__icon" />
                        <strong>{provider.id}</strong>
                        <span
                          aria-label={provider.status}
                          className="models-provider-item__status"
                          data-status={provider.status}
                          role="img"
                        />
                      </button>
                    </Reorder.Item>
                  ))}
                </Reorder.Group>
              </div>
            )
          })}
        </div>
      )}
      <button
        className="models-provider-add"
        data-active={selected === NEW_PROVIDER}
        onClick={() => onSelect(NEW_PROVIDER)}
        type="button"
      >
        <Plus aria-hidden="true" size={15} />
        <span>添加供应商</span>
      </button>
    </aside>
  )
}

function providerTypeLabel(value: string): string {
  return PROVIDER_TYPES.find((option) => option.value === value)?.label ?? value
}

function providerStatusLabel(value: string): string {
  if (value === 'connected') {
    return '已启用'
  }
  if (value === 'error') {
    return '配置异常'
  }
  return '未配置'
}

function ConfiguredProviderPanel({
  provider,
  data,
  disabled,
  onRemove,
  onRun,
  onSaved,
}: {
  readonly provider: ModelProvider
  readonly data: ModelCatalogData
  readonly disabled: boolean
  readonly onRemove: () => void
  readonly onRun: RunMutation
  readonly onSaved: (id: string) => void
}) {
  const models = data.models.filter((model) => model.provider === provider.id)
  const [editing, setEditing] = useState(false)
  const [editKey, setEditKey] = useState(0)
  const [name, setName] = useState(provider.id)
  /* 取消即弃稿：form 按 key 重挂，名字也回滚到已存值。 */
  const cancel = () => {
    setName(provider.id)
    setEditKey((key) => key + 1)
    setEditing(false)
  }

  return (
    <div className="models-provider-panel">
      <div className="models-provider-header">
        <div className="models-provider-heading">
          {editing ? (
            <input
              aria-label="供应商名称"
              className="models-provider-nameinput"
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          ) : (
            <>
              <h3>{provider.id}</h3>
              <button
                aria-label={`编辑供应商 ${provider.id}`}
                className="models-icon-button"
                onClick={() => setEditing(true)}
                title="编辑供应商"
                type="button"
              >
                <Pencil aria-hidden="true" size={14} />
              </button>
            </>
          )}
          <span className="models-provider-status" data-status={provider.status}>
            {providerStatusLabel(provider.status)}
          </span>
        </div>
        <button
          aria-label={`删除供应商 ${provider.id}`}
          className="models-icon-button models-button-danger"
          disabled={disabled}
          onClick={onRemove}
          title="删除供应商"
          type="button"
        >
          <Trash2 aria-hidden="true" size={15} />
        </button>
      </div>
      {editing ? (
        <ProviderForm
          current={{ models, provider }}
          disabled={disabled}
          key={`${provider.id}:${String(editKey)}`}
          name={name}
          onCancel={cancel}
          onRun={onRun}
          onSaved={(id) => {
            setEditing(false)
            onSaved(id)
          }}
        />
      ) : (
        <ProviderView models={models} provider={provider} />
      )}
    </div>
  )
}

/* 只读展示：读的是已存值，不读草稿；密钥只报有无，不出值。 */
function ProviderView({
  provider,
  models,
}: {
  readonly provider: ModelProvider
  readonly models: readonly ModelDescriptor[]
}) {
  const baseUrl = (provider.baseUrl ?? '').trim()
  return (
    <div className="models-provider-form">
      <div className="models-field">
        <span className="models-field__label">Base URL</span>
        <div>
          <output className="models-readonly">{baseUrl === '' ? '未设置' : baseUrl}</output>
        </div>
      </div>
      <div className="models-field">
        <span className="models-field__label">API 格式</span>
        <div>
          <output className="models-readonly">{providerTypeLabel(provider.providerType)}</output>
        </div>
      </div>
      <div className="models-field">
        <span className="models-field__label">API Key</span>
        <div>
          <output className="models-readonly">{provider.hasApiKey ? '••••••••' : '未配置'}</output>
        </div>
      </div>
      <div className="models-model-list">
        <span className="models-block__label">模型列表</span>
        <div className="models-model-card">
          {models.length === 0 ? (
            <p className="models-empty">还没有模型。</p>
          ) : (
            models.map((model) => {
              const badge = formatContextBadge(String(model.maxContextSize))
              return (
                <div className="models-model-entry" key={model.model}>
                  <div className="models-model-row">
                    <span className="models-model-idtext">
                      {modelIdForDraft(provider.id, model.model)}
                    </span>
                    {badge === null ? null : (
                      <span aria-hidden="true" className="models-model-badge">
                        {badge}
                      </span>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

function NewProviderPanel({
  data,
  disabled,
  onCreated,
  onModelVisibilityChange,
  onRun,
}: {
  readonly data: ModelCatalogData
  readonly disabled: boolean
  readonly onCreated: (id: string) => void
  readonly onModelVisibilityChange: (modelId: string, visible: boolean) => void
  readonly onRun: RunMutation
}) {
  const configured = new Set(data.providers.map((provider) => provider.id))
  const catalog = data.catalog.filter(
    (provider) => !configured.has(provider.id) && !provider.rejected && provider.models.length > 0,
  )
  const options: SelectOption[] = [
    { value: CUSTOM_PROVIDER, label: '自定义供应商' },
    ...catalog.map((provider) => ({ value: provider.id, label: provider.name })),
  ]
  const [selected, setSelected] = useState(CUSTOM_PROVIDER)
  const value = options.some((option) => option.value === selected) ? selected : CUSTOM_PROVIDER
  const provider = catalog.find((candidate) => candidate.id === value)
  const [name, setName] = useState(provider?.id ?? '')
  /* 换来源就是一张新草稿：名字回到该来源的默认值。 */
  useEffect(() => {
    setName(provider?.id ?? '')
  }, [provider?.id])
  return (
    <div className="models-provider-panel">
      <div className="models-provider-header">
        <div className="models-provider-heading">
          <input
            aria-label="供应商名称"
            className="models-provider-nameinput"
            onChange={(event) => setName(event.target.value)}
            placeholder="my-provider"
            value={name}
          />
          <span className="models-provider-status">未配置</span>
        </div>
      </div>
      <Field htmlFor="provider-source" label="供应商">
        <SearchableSelect
          className="models-provider-select"
          data={options}
          id="provider-source"
          onValueChange={setSelected}
          type="供应商"
          value={value}
        />
      </Field>
      {provider === undefined ? (
        <ProviderForm
          disabled={disabled}
          key={value}
          name={name}
          onRun={onRun}
          onSaved={onCreated}
        />
      ) : (
        <CatalogProviderForm
          disabled={disabled}
          key={provider.id}
          name={name}
          onCreated={onCreated}
          onModelVisibilityChange={onModelVisibilityChange}
          onRun={onRun}
          provider={provider}
        />
      )}
    </div>
  )
}

function CatalogProviderForm({
  provider,
  disabled,
  onCreated,
  onModelVisibilityChange,
  onRun,
  name,
}: {
  readonly provider: CatalogProvider
  readonly disabled: boolean
  readonly onCreated: (id: string) => void
  readonly onModelVisibilityChange: (modelId: string, visible: boolean) => void
  readonly onRun: RunMutation
  readonly name: string
}) {
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [visibleModels, setVisibleModels] = useState(() => provider.models.map((model) => model.id))
  const [message, setMessage] = useState<string | null>(null)
  const visible = new Set(visibleModels)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const localId = name.trim()
    if (localId === '') {
      setMessage('请填写供应商名称。')
      return
    }
    if (provider.needsBaseUrl && baseUrl.trim() === '') {
      setMessage('这个目录项需要 Base URL。')
      return
    }
    const ok = await onRun({
      kind: 'importCatalog',
      catalogId: provider.id,
      id: localId,
      ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
      ...(baseUrl.trim() === '' ? {} : { baseUrl: baseUrl.trim() }),
    })
    if (!ok) {
      return
    }
    for (const model of provider.models) {
      onModelVisibilityChange(modelAlias(localId, model.id), visible.has(model.id))
    }
    onCreated(localId)
  }
  return (
    <form className="models-provider-form" onSubmit={(event) => void submit(event)}>
      <Field htmlFor="catalog-provider-base-url" label="Base URL">
        <input
          className="models-input"
          id="catalog-provider-base-url"
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder={provider.needsBaseUrl ? 'https://api.example.com/v1' : '留空使用默认地址'}
          required={provider.needsBaseUrl}
          type="url"
          value={baseUrl}
        />
      </Field>
      <Field htmlFor="catalog-provider-format" label="API 格式">
        <output className="models-readonly" id="catalog-provider-format">
          {providerTypeLabel(provider.wireType ?? 'openai')}
        </output>
      </Field>
      <Field htmlFor="catalog-provider-api-key" label="API Key">
        <SecretInput
          autoComplete="new-password"
          id="catalog-provider-api-key"
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={`输入 ${provider.name} API Key`}
          value={apiKey}
        />
      </Field>
      <div className="models-provider-models">
        {provider.models.map((model) => (
          <div className="models-provider-model" key={model.id}>
            <div>
              <strong>{model.name ?? model.id}</strong>
            </div>
            <Switch
              aria-label={`在输入框中显示 ${model.name ?? model.id}`}
              checked={visible.has(model.id)}
              onCheckedChange={(checked) =>
                setVisibleModels((current) =>
                  checked
                    ? [...new Set([...current, model.id])]
                    : current.filter((id) => id !== model.id),
                )
              }
              size="sm"
            />
          </div>
        ))}
      </div>
      <ActionRow disabled={disabled} message={message} />
    </form>
  )
}

interface ModelDraft {
  readonly key: string
  readonly model: string
  readonly displayName: string
  readonly maxContextSize: string
  readonly thinkingCapability: 'thinking' | 'always_thinking' | null
  readonly supportEfforts: string
  readonly otherCapabilities: readonly string[]
  readonly writeFields: Pick<ProviderModelInput, 'maxOutputSize' | 'adaptiveThinking'>
}
const emptyModel = (): ModelDraft => ({
  key: crypto.randomUUID(),
  model: '',
  displayName: '',
  maxContextSize: '',
  thinkingCapability: null,
  supportEfforts: '',
  otherCapabilities: [],
  writeFields: {},
})
const draftFromModel = (model: ModelDescriptor, providerId: string): ModelDraft => ({
  key: crypto.randomUUID(),
  model: modelIdForDraft(providerId, model.model),
  displayName: model.displayName ?? '',
  maxContextSize: String(model.maxContextSize),
  thinkingCapability: model.capabilities?.includes('always_thinking')
    ? 'always_thinking'
    : model.capabilities?.includes('thinking') ||
        model.adaptiveThinking === true ||
        (model.supportEfforts?.length ?? 0) > 0
      ? 'thinking'
      : null,
  supportEfforts: model.supportEfforts?.join(', ') ?? '',
  otherCapabilities: (model.capabilities ?? []).filter(
    (capability) => capability !== 'thinking' && capability !== 'always_thinking',
  ),
  writeFields: {
    ...(model.maxOutputSize === null ? {} : { maxOutputSize: model.maxOutputSize }),
    ...(model.adaptiveThinking === null ? {} : { adaptiveThinking: model.adaptiveThinking }),
  },
})
const parsedEfforts = (value: string): string[] => [
  ...new Set(
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  ),
]
function validateModels(
  models: readonly ModelDraft[],
): { ok: true; models: ProviderModelInput[] } | { ok: false; message: string } {
  const seen = new Set<string>()
  const result: ProviderModelInput[] = []
  for (const draft of models) {
    const model = draft.model.trim()
    const maxContextSize = Number(draft.maxContextSize)
    if (model === '' || !Number.isSafeInteger(maxContextSize) || maxContextSize < 1) {
      return { ok: false, message: '每个模型都要填写模型 ID 和正整数上下文长度。' }
    }
    if (seen.has(model)) {
      return { ok: false, message: `模型 ID 不能重复：${model}` }
    }
    seen.add(model)
    const capabilities = [
      ...draft.otherCapabilities,
      ...(draft.thinkingCapability === null ? [] : [draft.thinkingCapability]),
    ]
    const efforts = parsedEfforts(draft.supportEfforts)
    result.push({
      model,
      maxContextSize,
      ...draft.writeFields,
      ...(capabilities.length === 0 ? {} : { capabilities }),
      ...(draft.thinkingCapability === null || efforts.length === 0
        ? {}
        : { supportEfforts: efforts }),
      ...(draft.thinkingCapability === null
        ? {}
        : { adaptiveThinking: draft.writeFields.adaptiveThinking }),
      ...(draft.displayName.trim() === '' ? {} : { displayName: draft.displayName.trim() }),
    })
  }
  return result.length === 0
    ? { ok: false, message: '至少配置一个模型。' }
    : { ok: true, models: result }
}

interface ProviderFormCurrent {
  readonly provider: ModelProvider
  readonly models: readonly ModelDescriptor[]
}

function modelIdForDraft(providerId: string, alias: string): string {
  const prefix = `${providerId}/`

  return alias.startsWith(prefix) ? alias.slice(prefix.length) : alias
}

function defaultModelOf(
  models: readonly ProviderModelInput[],
  current: ProviderFormCurrent | undefined,
): string | undefined {
  const [firstModel] = models
  if (current === undefined) {
    return firstModel?.model
  }
  const prefix = `${current.provider.id}/`
  const configured = current.provider.defaultModel?.startsWith(prefix)
    ? current.provider.defaultModel.slice(prefix.length)
    : undefined
  if (configured !== undefined && models.some((model) => model.model === configured)) {
    return configured
  }
  return firstModel?.model
}

function providerDetailsOf(
  providerType: string,
  models: ProviderModelInput[],
  defaultModel: string | undefined,
  baseUrl: string,
): {
  readonly providerType: string
  readonly models: ProviderModelInput[]
  readonly defaultModel?: string
  readonly baseUrl?: string
} {
  const trimmedBase = baseUrl.trim()
  return {
    providerType,
    models,
    ...(defaultModel === undefined ? {} : { defaultModel }),
    ...(trimmedBase === '' ? {} : { baseUrl: trimmedBase }),
  }
}

function saveProvider(args: {
  readonly current: ProviderFormCurrent | undefined
  readonly providerId: string
  readonly details: ReturnType<typeof providerDetailsOf>
  readonly secret: string
  readonly onRun: RunMutation
}): Promise<boolean> {
  if (args.current === undefined) {
    return args.onRun({
      kind: 'create',
      provider: {
        id: args.providerId,
        ...args.details,
        ...(args.secret === '' ? {} : { apiKey: args.secret }),
      },
    })
  }
  return args.onRun({
    kind: 'replace',
    providerId: args.current.provider.id,
    provider: {
      ...args.details,
      ...(args.providerId === args.current.provider.id ? {} : { newId: args.providerId }),
      ...(args.secret === '' ? {} : { apiKey: args.secret }),
    },
  })
}

function ProviderForm({
  current,
  disabled,
  onSaved,
  onRun,
  onCancel,
  name,
}: {
  readonly current?: ProviderFormCurrent
  readonly disabled: boolean
  readonly onSaved: (id: string) => void
  readonly onRun: RunMutation
  readonly onCancel?: () => void
  /* 名字受控：标题栏那一行输入与这里是同一份值。 */
  readonly name: string
}) {
  const [providerType, setProviderType] = useState(current?.provider.providerType ?? 'openai')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(current?.provider.baseUrl ?? '')
  const [models, setModels] = useState<ModelDraft[]>(() =>
    current === undefined
      ? [emptyModel()]
      : current.models.map((model) => draftFromModel(model, current.provider.id)),
  )
  const [message, setMessage] = useState<string | null>(null)
  const updateModel = (key: string, change: Partial<ModelDraft>) =>
    setModels((value) =>
      value.map((model) => (model.key === key ? { ...model, ...change } : model)),
    )
  const addModel = () => {
    const fresh = emptyModel()
    setModels((value) => [...value, fresh])
    return fresh.key
  }
  const removeModel = (key: string) =>
    setModels((value) => value.filter((item) => item.key !== key))
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const providerId = name.trim()
    const validation = validateModels(models)

    if (providerId === '') {
      setMessage('请填写供应商名称。')
      return
    }

    if (!validation.ok) {
      setMessage(validation.message)
      return
    }

    const details = providerDetailsOf(
      providerType,
      validation.models,
      defaultModelOf(validation.models, current),
      baseUrl,
    )
    const ok = await saveProvider({
      current,
      providerId,
      details,
      secret: apiKey.trim(),
      onRun,
    })

    if (ok) {
      onSaved(providerId)
    }
  }

  return (
    <form className="models-provider-form" onSubmit={(event) => void submit(event)}>
      <Field htmlFor="provider-form-base-url" label="Base URL">
        <input
          className="models-input"
          id="provider-form-base-url"
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://api.example.com/v1"
          type="url"
          value={baseUrl}
        />
      </Field>
      <Field htmlFor="provider-form-protocol" label="API 格式">
        <Select
          className="models-provider-select"
          data={PROVIDER_TYPES}
          id="provider-form-protocol"
          onValueChange={setProviderType}
          type="API 格式"
          value={providerType}
        />
      </Field>
      <Field htmlFor="provider-form-api-key" label="API Key">
        <SecretInput
          autoComplete="new-password"
          id="provider-form-api-key"
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={current?.provider.hasApiKey ? '留空保留现有 Key' : '输入 key...'}
          value={apiKey}
        />
      </Field>
      <ModelListEditor
        disabled={disabled}
        message={message}
        models={models}
        onAdd={addModel}
        onRemove={removeModel}
        onUpdate={updateModel}
        {...(onCancel === undefined ? {} : { onCancel })}
      />
    </form>
  )
}

/* 上下文徽标：1000000 报 1M，凑不整的按千分位原文。非法值不报，留给校验说话。 */
function formatContextBadge(value: string): string | null {
  const size = Number(value)
  if (!Number.isSafeInteger(size) || size < 1) {
    return null
  }
  if (size % 1_000_000 === 0) {
    return `${String(size / 1_000_000)}M`
  }
  if (size % 1_000 === 0) {
    return `${String(size / 1_000)}K`
  }
  return TOKEN_FORMAT.format(size)
}

/* 紧凑模型列表：行内只留 ID 与徽标，显示名/上下文走编辑区，思考走参数区。
 * 保存语义不变：仍是整张表单一次提交，这里的按钮只是位置变了。 */
function ModelListEditor({
  models,
  disabled,
  message,
  onUpdate,
  onAdd,
  onRemove,
  onCancel,
}: {
  readonly models: readonly ModelDraft[]
  readonly disabled: boolean
  readonly message: string | null
  readonly onUpdate: (key: string, change: Partial<ModelDraft>) => void
  readonly onAdd: () => string
  readonly onRemove: (key: string) => void
  readonly onCancel?: () => void
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (section: string) =>
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(section)) {
        next.delete(section)
      } else {
        next.add(section)
      }
      return next
    })
  const remove = (key: string) => {
    setOpen((current) => new Set([...current].filter((section) => !section.startsWith(`${key}:`))))
    onRemove(key)
  }
  return (
    <div className="models-model-list">
      <span className="models-block__label">模型列表</span>
      <div className="models-model-card">
        {models.map((model, index) => {
          const badge = formatContextBadge(model.maxContextSize)
          const editId = `model-${model.key}-edit`
          const tuneId = `model-${model.key}-tune`
          const editOpen = open.has(`${model.key}:edit`)
          const tuneOpen = open.has(`${model.key}:tune`)
          const name = model.model.trim() === '' ? `模型 ${String(index + 1)}` : model.model
          return (
            <div className="models-model-entry" key={model.key}>
              <div className="models-model-row">
                <div className="models-model-idwrap">
                  <input
                    aria-label={`${name} ID`}
                    className="models-input models-model-id"
                    onChange={(event) => onUpdate(model.key, { model: event.target.value })}
                    placeholder="模型 ID"
                    required
                    value={model.model}
                  />
                  {badge === null ? null : (
                    <span aria-hidden="true" className="models-model-badge">
                      {badge}
                    </span>
                  )}
                </div>
                <button
                  aria-controls={tuneId}
                  aria-expanded={tuneOpen}
                  aria-label={`${name}参数`}
                  className="models-icon-button"
                  onClick={() => toggle(`${model.key}:tune`)}
                  type="button"
                >
                  <SlidersHorizontal aria-hidden="true" size={15} />
                </button>
                <button
                  aria-controls={editId}
                  aria-expanded={editOpen}
                  aria-label={`编辑${name}`}
                  className="models-icon-button"
                  onClick={() => toggle(`${model.key}:edit`)}
                  type="button"
                >
                  <Pencil aria-hidden="true" size={15} />
                </button>
                <button
                  aria-label={`删除${name}`}
                  className="models-icon-button"
                  disabled={models.length === 1}
                  onClick={() => remove(model.key)}
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={15} />
                </button>
              </div>
              {editOpen ? (
                <div className="models-model-section" id={editId}>
                  <input
                    aria-label={`${name}显示名`}
                    className="models-input"
                    onChange={(event) => onUpdate(model.key, { displayName: event.target.value })}
                    placeholder="显示名（可选）"
                    value={model.displayName}
                  />
                  <input
                    aria-label={`${name}上下文长度`}
                    className="models-input"
                    min="1"
                    onChange={(event) =>
                      onUpdate(model.key, { maxContextSize: event.target.value })
                    }
                    placeholder="上下文"
                    required
                    type="number"
                    value={model.maxContextSize}
                  />
                </div>
              ) : null}
              {tuneOpen ? (
                <div className="models-model-section" id={tuneId}>
                  <div className="models-thinking-toggle">
                    <Switch
                      aria-label={`${name}思考能力`}
                      checked={model.thinkingCapability !== null}
                      onCheckedChange={(checked) =>
                        onUpdate(model.key, {
                          thinkingCapability: checked
                            ? (model.thinkingCapability ?? 'thinking')
                            : null,
                        })
                      }
                      size="sm"
                    />
                    <span>思考</span>
                  </div>
                  <input
                    aria-label={`${name}思考强度`}
                    className="models-input"
                    disabled={model.thinkingCapability === null}
                    onChange={(event) =>
                      onUpdate(model.key, { supportEfforts: event.target.value })
                    }
                    placeholder="low, medium, high"
                    value={model.supportEfforts}
                  />
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
      <div className="models-model-footer">
        <Button
          onClick={() => {
            const key = onAdd()
            setOpen((current) => new Set(current).add(`${key}:edit`))
          }}
          size="xs"
          type="button"
          variant="soft"
        >
          <Plus aria-hidden="true" size={14} /> 添加模型
        </Button>
        <span aria-live="polite" className="models-model-message">
          {message}
        </span>
        {disabled ? <InlineSpinner /> : null}
        {onCancel === undefined ? null : (
          <Button onClick={onCancel} size="xs" type="button" variant="ghost">
            取消
          </Button>
        )}
        <Button disabled={disabled} size="xs" type="submit" variant="soft">
          {disabled ? '正在保存…' : '保存'}
        </Button>
      </div>
    </div>
  )
}

type SecretInputProps = Omit<ComponentProps<'input'>, 'type'>
function SecretInput({ className, disabled, ...props }: SecretInputProps) {
  const [revealed, setRevealed] = useState(false)
  return (
    <span className="models-secret">
      <input
        {...props}
        className={`models-input ${className ?? ''}`}
        disabled={disabled}
        type={revealed ? 'text' : 'password'}
      />
      <button
        aria-label={revealed ? '隐藏 API Key' : '显示 API Key'}
        className="models-secret__toggle"
        disabled={disabled}
        onClick={() => setRevealed((value) => !value)}
        type="button"
      >
        {revealed ? <EyeOff aria-hidden="true" size={15} /> : <Eye aria-hidden="true" size={15} />}
      </button>
    </span>
  )
}

function Field({
  label,
  htmlFor,
  children,
}: {
  readonly label: string
  readonly htmlFor: string
  readonly children: ReactNode
}) {
  return (
    <div className="models-field">
      <label htmlFor={htmlFor}>{label}</label>
      <div>{children}</div>
    </div>
  )
}
function ActionRow({
  disabled,
  message,
}: {
  readonly disabled: boolean
  readonly message: string | null
}) {
  return (
    <div className="models-actions">
      <span aria-live="polite">{message}</span>
      <div>
        {disabled ? <InlineSpinner /> : null}
        <Button disabled={disabled} size="xs" type="submit" variant="soft">
          {disabled ? '正在保存…' : '保存'}
        </Button>
      </div>
    </div>
  )
}
