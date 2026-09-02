import { agent } from '@poietica/agent-catalog'
import {
  Button,
  ConfirmationDialog,
  InlineSpinner,
  Select,
  type SelectOption,
  Switch,
} from '@poietica/design-system'
import type {
  AgentSettings,
  CatalogProvider,
  ModelCatalogData,
  ModelCatalogOperation,
  ModelCatalogStore,
  ModelDescriptor,
  ModelProvider,
  ProviderInput,
  ProviderModelInput,
} from '@poietica/settings'
import { Box, Eye, EyeOff, Plus, RotateCw, Trash2 } from 'lucide-react'
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
import { describeAgentCliFailure } from '../agent-install/agent-cli-text'
import { AgentInstallAction } from '../agent-install/agent-install-action'
import './models-settings.css'

const COLLAPSED_MODEL_LIMIT = 8
const NEW_PROVIDER = '__new_provider__'
const CUSTOM_PROVIDER = '__custom_provider__'
const PROVIDER_TYPES: SelectOption[] = [
  { value: 'openai', label: 'OpenAI Chat' },
  { value: 'openai_responses', label: 'OpenAI Responses' },
  { value: 'anthropic', label: 'Anthropic' },
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
        loading={snapshot.loading}
        onModelVisibilityChange={onModelVisibilityChange}
        onRefresh={store.refresh}
      />
      <ProviderWorkspace
        data={snapshot.data}
        disabled={snapshot.mutating}
        hiddenModelAliases={hiddenModelAliases}
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
  readonly onRefresh: () => Promise<void>
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
            aria-label="重新读取模型配置"
            className="models-icon-button"
            disabled={loading}
            onClick={() => void onRefresh()}
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
  hiddenModelAliases,
  providerOrder,
  onModelVisibilityChange,
  onProviderOrderChange,
  onRemove,
  onRun,
}: {
  readonly data: ModelCatalogData
  readonly disabled: boolean
  readonly hiddenModelAliases: readonly string[]
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
              hiddenModelAliases={hiddenModelAliases}
              key={provider.id}
              onModelVisibilityChange={onModelVisibilityChange}
              onRemove={() => onRemove(provider.id)}
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
  selected,
  onSelect,
  onOrderChange,
}: {
  readonly providers: readonly ModelProvider[]
  readonly selected: string
  readonly onSelect: (id: string) => void
  readonly onOrderChange: (providerIds: readonly string[]) => void
}) {
  const ids = providers.map((provider) => provider.id)
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
  return (
    <aside className="models-provider-rail">
      <span className="models-provider-rail__label">供应商</span>
      <Reorder.Group
        aria-label="供应商顺序"
        as="nav"
        axis="y"
        className="models-provider-rail__list"
        layoutScroll
        onReorder={(next) => onOrderChange(next)}
        values={ids}
      >
        {providers.map((provider) => (
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
    return '已配置'
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
  hiddenModelAliases,
  onModelVisibilityChange,
  onRemove,
}: {
  readonly provider: ModelProvider
  readonly data: ModelCatalogData
  readonly disabled: boolean
  readonly hiddenModelAliases: readonly string[]
  readonly onModelVisibilityChange: (modelId: string, visible: boolean) => void
  readonly onRemove: () => void
}) {
  const hidden = useMemo(() => new Set(hiddenModelAliases), [hiddenModelAliases])
  const models = data.models.filter((model) => model.provider === provider.id)
  return (
    <div className="models-provider-panel">
      <div className="models-provider-header">
        <div className="models-provider-heading">
          <h3>{provider.id}</h3>
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
      <div className="models-provider-form">
        <Field htmlFor="configured-provider-base-url" label="Base URL">
          <output className="models-readonly" id="configured-provider-base-url">
            {provider.baseUrl ?? '使用协议默认地址'}
          </output>
        </Field>
        <Field htmlFor="configured-provider-format" label="API 格式">
          <output className="models-readonly" id="configured-provider-format">
            {providerTypeLabel(provider.providerType)}
          </output>
        </Field>
        <Field htmlFor="configured-provider-key" label="API Key">
          <output className="models-readonly" id="configured-provider-key">
            {provider.hasApiKey ? '••••••••••••••••' : '未配置'}
          </output>
        </Field>
        <div className="models-provider-models">
          <div className="models-provider-models__header">
            <strong>模型列表</strong>
            <span>控制是否出现在输入框</span>
          </div>
          {models.length === 0 ? (
            <p className="models-empty">这个供应商还没有模型。</p>
          ) : (
            models.map((model) => (
              <div className="models-provider-model" key={model.model}>
                <div>
                  <strong>{model.displayName ?? model.model}</strong>
                  <small>{`${model.model} · ${TOKEN_FORMAT.format(model.maxContextSize)}`}</small>
                </div>
                <Switch
                  aria-label={`在输入框中显示 ${model.displayName ?? model.model}`}
                  checked={!hidden.has(model.model)}
                  onCheckedChange={(visible) => onModelVisibilityChange(model.model, visible)}
                  size="sm"
                />
              </div>
            ))
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
  return (
    <div className="models-provider-panel">
      <div className="models-provider-header">
        <div className="models-provider-heading">
          <h3>{provider?.name ?? '自定义供应商'}</h3>
          <span className="models-provider-status">未配置</span>
        </div>
      </div>
      <Field htmlFor="provider-source" label="供应商">
        <Select
          className="models-provider-select"
          data={options}
          id="provider-source"
          onValueChange={setSelected}
          type="供应商"
          value={value}
        />
      </Field>
      {provider === undefined ? (
        <CustomProviderForm disabled={disabled} key={value} onCreated={onCreated} onRun={onRun} />
      ) : (
        <CatalogProviderForm
          disabled={disabled}
          key={provider.id}
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
}: {
  readonly provider: CatalogProvider
  readonly disabled: boolean
  readonly onCreated: (id: string) => void
  readonly onModelVisibilityChange: (modelId: string, visible: boolean) => void
  readonly onRun: RunMutation
}) {
  const [id, setId] = useState(provider.id)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [visibleModels, setVisibleModels] = useState(() => provider.models.map((model) => model.id))
  const [message, setMessage] = useState<string | null>(null)
  const visible = new Set(visibleModels)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const localId = id.trim()
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
      onModelVisibilityChange(`${localId}/${model.id}`, visible.has(model.id))
    }
    onCreated(localId)
  }
  return (
    <form className="models-provider-form" onSubmit={(event) => void submit(event)}>
      <Field htmlFor="catalog-provider-id" label="供应商名称">
        <input
          className="models-input"
          id="catalog-provider-id"
          onChange={(event) => setId(event.target.value)}
          required
          value={id}
        />
      </Field>
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
        <div className="models-provider-models__header">
          <strong>模型列表</strong>
          <span>默认全部显示，可按需关闭</span>
        </div>
        {provider.models.map((model) => (
          <div className="models-provider-model" key={model.id}>
            <div>
              <strong>{model.name ?? model.id}</strong>
              <small>{`${model.id} · ${TOKEN_FORMAT.format(model.maxContextSize)}`}</small>
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
}
const emptyModel = (): ModelDraft => ({
  key: crypto.randomUUID(),
  model: '',
  displayName: '',
  maxContextSize: '128000',
})
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
    result.push({
      model,
      maxContextSize,
      ...(draft.displayName.trim() === '' ? {} : { displayName: draft.displayName.trim() }),
    })
  }
  return result.length === 0
    ? { ok: false, message: '至少配置一个模型。' }
    : { ok: true, models: result }
}

function CustomProviderForm({
  disabled,
  onCreated,
  onRun,
}: {
  readonly disabled: boolean
  readonly onCreated: (id: string) => void
  readonly onRun: RunMutation
}) {
  const [id, setId] = useState('')
  const [providerType, setProviderType] = useState('openai')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [models, setModels] = useState<ModelDraft[]>([emptyModel()])
  const [message, setMessage] = useState<string | null>(null)
  const updateModel = (key: string, change: Partial<ModelDraft>) =>
    setModels((current) =>
      current.map((model) => (model.key === key ? { ...model, ...change } : model)),
    )
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const providerId = id.trim()
    const validation = validateModels(models)
    if (providerId === '') {
      setMessage('请填写供应商名称。')
      return
    }
    if (!validation.ok) {
      setMessage(validation.message)
      return
    }
    const [firstModel] = validation.models
    const provider: ProviderInput = {
      id: providerId,
      providerType,
      models: validation.models,
      ...(firstModel === undefined ? {} : { defaultModel: firstModel.model }),
      ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
      ...(baseUrl.trim() === '' ? {} : { baseUrl: baseUrl.trim() }),
    }
    if (await onRun({ kind: 'create', provider })) {
      onCreated(providerId)
    }
  }
  return (
    <form className="models-provider-form" onSubmit={(event) => void submit(event)}>
      <Field htmlFor="custom-provider-id" label="供应商名称">
        <input
          className="models-input"
          id="custom-provider-id"
          onChange={(event) => setId(event.target.value)}
          placeholder="my-provider"
          required
          value={id}
        />
      </Field>
      <Field htmlFor="custom-provider-base-url" label="Base URL">
        <input
          className="models-input"
          id="custom-provider-base-url"
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://api.example.com/v1"
          type="url"
          value={baseUrl}
        />
      </Field>
      <Field htmlFor="custom-provider-protocol" label="API 格式">
        <Select
          className="models-provider-select"
          data={PROVIDER_TYPES}
          id="custom-provider-protocol"
          onValueChange={setProviderType}
          type="API 格式"
          value={providerType}
        />
      </Field>
      <Field htmlFor="custom-provider-api-key" label="API Key">
        <SecretInput
          autoComplete="new-password"
          id="custom-provider-api-key"
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="输入key..."
          value={apiKey}
        />
      </Field>
      <div className="models-editor">
        <div className="models-editor__header">
          <div>
            <strong>模型列表</strong>
            <span>模型 ID、显示名与上下文长度</span>
          </div>
          <Button
            onClick={() => setModels((current) => [...current, emptyModel()])}
            size="xs"
            type="button"
            variant="soft"
          >
            <Plus aria-hidden="true" size={14} /> 添加模型
          </Button>
        </div>
        {models.map((model) => (
          <div className="models-editor__row" key={model.key}>
            <input
              aria-label="模型 ID"
              className="models-input"
              onChange={(event) => updateModel(model.key, { model: event.target.value })}
              placeholder="模型 ID"
              required
              value={model.model}
            />
            <input
              aria-label="模型显示名"
              className="models-input"
              onChange={(event) => updateModel(model.key, { displayName: event.target.value })}
              placeholder="显示名（可选）"
              value={model.displayName}
            />
            <input
              aria-label="上下文长度"
              className="models-input"
              min="1"
              onChange={(event) => updateModel(model.key, { maxContextSize: event.target.value })}
              placeholder="上下文"
              required
              type="number"
              value={model.maxContextSize}
            />
            <button
              aria-label="删除模型"
              className="models-icon-button"
              disabled={models.length === 1}
              onClick={() =>
                setModels((current) => current.filter((item) => item.key !== model.key))
              }
              type="button"
            >
              <Trash2 aria-hidden="true" size={15} />
            </button>
          </div>
        ))}
      </div>
      <ActionRow disabled={disabled} message={message} />
    </form>
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
