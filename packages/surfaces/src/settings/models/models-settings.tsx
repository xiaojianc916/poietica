import { agent } from '@poietica/agent-catalog'
import {
  Button,
  ConfirmationDialog,
  InlineSpinner,
  Select,
  type SelectOption,
} from '@poietica/design-system'
import type {
  AgentSettings,
  CatalogModel,
  CatalogProvider,
  ModelCatalogData,
  ModelCatalogStore,
  ModelDescriptor,
  ProviderInput,
  ProviderModelInput,
} from '@poietica/settings'
import { Plus, RotateCw, Trash2 } from 'lucide-react'
import {
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

export interface ModelsSettingsProps {
  readonly store: AgentSettings
  readonly modelCatalog: ModelCatalogStore
}

export function ModelsSettings({ store, modelCatalog }: ModelsSettingsProps) {
  const [agentError, setAgentError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void store.load().then(
      (snapshot) => {
        if (active) {
          setAgentError(snapshot.issues.length > 0 ? snapshot.issues.join('；') : null)
        }
      },
      (cause: unknown) => {
        if (active) {
          setAgentError(describeAgentCliFailure(cause, 'agent 配置读取失败，请重试。'))
        }
      },
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
            <div className="models-row__control">
              <AgentInstallAction agentId={agent.id} store={store} />
            </div>
          </div>
        </div>
      </div>
      <ModelCatalogPanel store={modelCatalog} />
    </section>
  )
}

function ModelCatalogPanel({ store }: { readonly store: ModelCatalogStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [actionError, setActionError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)

  useEffect(() => {
    void store.load()
  }, [store])

  const run = async (operation: Parameters<ModelCatalogStore['mutate']>[0]): Promise<boolean> => {
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
      <ConfiguredModels data={snapshot.data} loading={snapshot.loading} onRefresh={store.refresh} />
      <ConfiguredProviders
        data={snapshot.data}
        disabled={snapshot.mutating}
        onRemove={setRemoving}
      />
      <ProviderComposer data={snapshot.data} disabled={snapshot.mutating} onRun={run} />
      <ConfirmationDialog
        busy={snapshot.mutating}
        confirmLabel="删除"
        description={`删除 ${removing ?? ''} 后，它的模型与密钥一起从 agent 配置里移除。`}
        destructive
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing !== null) {
            void run({ kind: 'delete', providerId: removing })
          }
          setRemoving(null)
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
}: {
  readonly data: ModelCatalogData
  readonly loading: boolean
  readonly onRefresh: () => Promise<void>
}) {
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)
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
            className="models-input models-input--search"
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
              <ConfiguredModel key={model.model} model={model} />
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

function ConfiguredModel({ model }: { readonly model: ModelDescriptor }) {
  return (
    <div className="models-row models-row--compact">
      <div className="models-row__copy">
        <span className="models-row__name">{model.displayName ?? model.model}</span>
        <p>{model.model}</p>
      </div>
      <span className="models-row__meta">
        {`${model.provider} · ${TOKEN_FORMAT.format(model.maxContextSize)} 上下文`}
      </span>
    </div>
  )
}

function ConfiguredProviders({
  data,
  disabled,
  onRemove,
}: {
  readonly data: ModelCatalogData
  readonly disabled: boolean
  readonly onRemove: (id: string) => void
}) {
  return (
    <div className="models-block">
      <span className="models-block__label">已配置的服务商</span>
      <div className="models-card models-card--list">
        {data.providers.length === 0 ? (
          <p className="models-empty">还没有服务商。</p>
        ) : (
          data.providers.map((provider) => (
            <div className="models-row" key={provider.id}>
              <div className="models-row__copy">
                <span className="models-row__name">{provider.id}</span>
                <p>{provider.hasApiKey ? '密钥已配置' : '未配置密钥'}</p>
              </div>
              <div className="models-row__control">
                <span className="models-row__meta">
                  {`${data.models.filter((model) => model.provider === provider.id).length} 个模型`}
                </span>
                <Button
                  className="models-button-danger"
                  disabled={disabled}
                  onClick={() => onRemove(provider.id)}
                  size="xs"
                  type="button"
                  variant="soft"
                >
                  删除
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function ProviderComposer({
  data,
  disabled,
  onRun,
}: {
  readonly data: ModelCatalogData
  readonly disabled: boolean
  readonly onRun: (operation: Parameters<ModelCatalogStore['mutate']>[0]) => Promise<boolean>
}) {
  const configured = new Set(data.providers.map((provider) => provider.id))
  const catalog = data.catalog.filter(
    (provider) => !configured.has(provider.id) && !provider.rejected && provider.models.length > 0,
  )
  const options: SelectOption[] = [
    ...catalog.map((provider) => ({ value: provider.id, label: provider.name })),
    { value: CUSTOM_PROVIDER, label: '自定义服务商' },
  ]
  const [selected, setSelected] = useState(options[0]?.value ?? CUSTOM_PROVIDER)
  const selectedValue = options.some((option) => option.value === selected)
    ? selected
    : (options[0]?.value ?? CUSTOM_PROVIDER)
  const provider = catalog.find((candidate) => candidate.id === selectedValue)

  return (
    <div className="models-block">
      <span className="models-block__label">添加 API</span>
      <div className="models-card">
        <div className="models-row models-row--field">
          <span className="models-row__name">服务商</span>
          <div className="models-row__control">
            <Select
              align="end"
              className="models-select-trigger"
              data={options}
              onValueChange={setSelected}
              type="服务商"
              value={selectedValue}
            />
          </div>
        </div>
        {provider === undefined ? (
          <CustomProviderForm disabled={disabled} key={selectedValue} onRun={onRun} />
        ) : (
          <CatalogProviderForm
            disabled={disabled}
            key={provider.id}
            onRun={onRun}
            provider={provider}
          />
        )}
      </div>
    </div>
  )
}

function CatalogProviderForm({
  provider,
  disabled,
  onRun,
}: {
  readonly provider: CatalogProvider
  readonly disabled: boolean
  readonly onRun: (operation: Parameters<ModelCatalogStore['mutate']>[0]) => Promise<boolean>
}) {
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const ok = await onRun({
      kind: 'importCatalog',
      catalogId: provider.id,
      ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
      ...(baseUrl.trim() === '' ? {} : { baseUrl: baseUrl.trim() }),
    })
    if (ok) {
      setApiKey('')
      setMessage('已写入 agent 配置。')
    }
  }

  return (
    <form className="models-provider-form" onSubmit={(event) => void submit(event)}>
      <Field htmlFor="catalog-provider-api-key" label="API 密钥">
        <input
          autoComplete="new-password"
          className="models-input models-input--inline"
          id="catalog-provider-api-key"
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={`输入 ${provider.name} API 密钥`}
          type="password"
          value={apiKey}
        />
      </Field>
      {provider.needsBaseUrl ? (
        <Field htmlFor="catalog-provider-base-url" label="接口地址">
          <input
            className="models-input models-input--inline"
            id="catalog-provider-base-url"
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.example.com/v1"
            required
            type="url"
            value={baseUrl}
          />
        </Field>
      ) : null}
      <ModelPreview models={provider.models} />
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

function emptyModel(): ModelDraft {
  return { key: crypto.randomUUID(), model: '', displayName: '', maxContextSize: '128000' }
}

function validateCustomProviderModels(
  models: readonly ModelDraft[],
):
  | { ok: true; modelInputs: ProviderModelInput[]; firstModel: ProviderModelInput }
  | { ok: false; message: string } {
  const seen = new Set<string>()
  const modelInputs: ProviderModelInput[] = []
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
    modelInputs.push({
      model,
      maxContextSize,
      ...(draft.displayName.trim() === '' ? {} : { displayName: draft.displayName.trim() }),
    })
  }
  const firstModel = modelInputs[0]
  if (firstModel === undefined) {
    return { ok: false, message: '至少配置一个模型。' }
  }
  return { ok: true, modelInputs, firstModel }
}

function CustomProviderForm({
  disabled,
  onRun,
}: {
  readonly disabled: boolean
  readonly onRun: (operation: Parameters<ModelCatalogStore['mutate']>[0]) => Promise<boolean>
}) {
  const [id, setId] = useState('')
  const [providerType, setProviderType] = useState('openai')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [models, setModels] = useState<ModelDraft[]>([emptyModel()])
  const [message, setMessage] = useState<string | null>(null)

  const updateModel = (key: string, change: Partial<ModelDraft>) => {
    setModels((current) =>
      current.map((model) => (model.key === key ? { ...model, ...change } : model)),
    )
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const validation = validateCustomProviderModels(models)
    if (!validation.ok) {
      setMessage(validation.message)
      return
    }
    const { modelInputs, firstModel } = validation
    const providerId = id.trim()
    if (providerId === '') {
      setMessage('请填写服务商 ID。')
      return
    }
    const provider: ProviderInput = {
      id: providerId,
      providerType,
      models: modelInputs,
      defaultModel: firstModel.model,
      ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
      ...(baseUrl.trim() === '' ? {} : { baseUrl: baseUrl.trim() }),
    }
    const ok = await onRun({ kind: 'create', provider })
    if (ok) {
      setApiKey('')
      setMessage('已写入 agent 配置。')
    }
  }

  return (
    <form className="models-provider-form" onSubmit={(event) => void submit(event)}>
      <Field htmlFor="custom-provider-id" label="服务商 ID">
        <input
          className="models-input models-input--inline"
          id="custom-provider-id"
          onChange={(event) => setId(event.target.value)}
          placeholder="my-provider"
          required
          value={id}
        />
      </Field>
      <Field htmlFor="custom-provider-protocol" label="协议">
        <Select
          align="end"
          className="models-select-trigger"
          data={PROVIDER_TYPES}
          id="custom-provider-protocol"
          onValueChange={setProviderType}
          type="协议"
          value={providerType}
        />
      </Field>
      <Field htmlFor="custom-provider-api-key" label="API 密钥">
        <input
          autoComplete="new-password"
          className="models-input models-input--inline"
          id="custom-provider-api-key"
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="留空表示由环境或协议自行认证"
          type="password"
          value={apiKey}
        />
      </Field>
      <Field htmlFor="custom-provider-base-url" label="接口地址">
        <input
          className="models-input models-input--inline"
          id="custom-provider-base-url"
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://api.example.com/v1"
          type="url"
          value={baseUrl}
        />
      </Field>
      <div className="models-editor">
        <div className="models-editor__header">
          <span className="models-row__name">模型</span>
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
              placeholder="上下文长度"
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
    <label className="models-row models-row--field" htmlFor={htmlFor}>
      <span className="models-row__name">{label}</span>
      <div className="models-row__control">{children}</div>
    </label>
  )
}

function ModelPreview({ models }: { readonly models: readonly CatalogModel[] }) {
  return (
    <div className="models-preview">
      <span className="models-row__name">将配置的模型</span>
      <div className="models-preview__list">
        {models.map((model) => (
          <span className="models-preview__item" key={model.id}>
            {`${model.name ?? model.id} · ${TOKEN_FORMAT.format(model.maxContextSize)}`}
          </span>
        ))}
      </div>
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
    <div className="models-row models-row--field">
      <span aria-live="polite" className="models-row__meta">
        {message}
      </span>
      <div className="models-row__control">
        {disabled ? <InlineSpinner /> : null}
        <Button disabled={disabled} size="xs" type="submit" variant="soft">
          {disabled ? '正在保存…' : '保存到 agent'}
        </Button>
      </div>
    </div>
  )
}
