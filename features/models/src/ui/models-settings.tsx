import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
  Button,
  ConfirmationDialog,
  InlineSpinner,
  SegmentedControl,
  type SegmentedOption,
  Select,
  type SelectOption,
  Switch,
} from '@poietica/design-system'
import { ArrowLeft, ChevronDown, Plus, RotateCw, Trash2 } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { describeAgentCliFailure } from './agent-cli-text'
import {
  type CatalogProvider,
  type ModelCatalogData,
  type ModelCatalogOperation,
  type ModelCatalogStore,
  type ModelDescriptor,
  type ModelProvider,
  modelAlias,
  type ProviderModelInput,
} from './model-catalog'
import './models-settings.css'
import type { ProviderAuthSlot } from './provider-auth'
import { SecretInput } from './secret-input'

const COLLAPSED_MODEL_LIMIT = 8
const ADD_PROVIDER = '__add_provider__'
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
  readonly modelCatalog: ModelCatalogStore
  readonly hiddenModelAliases: readonly string[]
  readonly providerOrder: readonly string[]
  readonly onModelVisibilityChange: (modelId: string, visible: boolean) => void
  /** 内置服务商的认证区（账号登录 / API Key）；自定义服务商仍走自己的表单 */
  readonly auth: ProviderAuthSlot
}

export function ModelsSettings({
  auth,
  modelCatalog,
  hiddenModelAliases,
  providerOrder,
  onModelVisibilityChange,
}: ModelsSettingsProps) {
  return (
    <section className="models-page">
      <ModelCatalogPanel
        auth={auth}
        hiddenModelAliases={hiddenModelAliases}
        onModelVisibilityChange={onModelVisibilityChange}
        providerOrder={providerOrder}
        store={modelCatalog}
      />
    </section>
  )
}

function ModelCatalogPanel({
  auth,
  store,
  hiddenModelAliases,
  providerOrder,
  onModelVisibilityChange,
}: {
  readonly auth: ProviderAuthSlot
  readonly store: ModelCatalogStore
  readonly hiddenModelAliases: readonly string[]
  readonly providerOrder: readonly string[]
  readonly onModelVisibilityChange: (modelId: string, visible: boolean) => void
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

  const removingCustom = snapshot.data?.providers.some((p) => p.id === removing && p.providerType === 'custom') ?? false

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
        auth={auth}
        data={snapshot.data}
        disabled={snapshot.mutating}
        onModelVisibilityChange={onModelVisibilityChange}
        onRemove={setRemoving}
        onRun={run}
        providerOrder={providerOrder}
      />
      <ConfirmationDialog
        busy={snapshot.mutating}
        confirmLabel={removingCustom ? '删除' : '移除'}
        description={
          removingCustom
            ? `删除 ${removing ?? ''} 后，它的模型与密钥一起从 agent 配置里移除。`
            : `将清除 ${removing ?? ''} 的 API Key 并退出账号登录。之后可以从目录重新添加。`
        }
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
        title={removingCustom ? '删除这个供应商？' : '移除这个供应商？'}
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
            className="settings-input"
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
            <RotateCw aria-hidden="true" />
          </button>
        </div>
        {models.length === 0 ? (
          <p className="models-empty">还没有已配置的模型。</p>
        ) : (
          <div className="models-list">
            {models.map((model) => {
              /* 可见性记的是别名 provider/id，与选择器 choices 的取值同一拼法：按裸 id 记，开关写下的那一格与选择器过滤读的那一格永远对不上。 */
              const alias = modelAlias(model.provider, model.model)

              return (
                <ConfiguredModel
                  key={alias}
                  model={model}
                  onVisibleChange={(visible) => onModelVisibilityChange(alias, visible)}
                  visible={!hidden.has(alias)}
                />
              )
            })}
          </div>
        )}
      </div>
      {data.models.length > COLLAPSED_MODEL_LIMIT && query.trim() === '' ? (
        <button
          className="models-link models-link--outside"
          onClick={() => setShowAll((value) => !value)}
          type="button"
        >
          {showAll ? '收起模型列表' : '查看全部模型'}
        </button>
      ) : null}
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
  auth,
  data,
  disabled,
  providerOrder,
  onModelVisibilityChange,
  onRemove,
  onRun,
}: {
  readonly auth: ProviderAuthSlot
  readonly data: ModelCatalogData
  readonly disabled: boolean
  readonly providerOrder: readonly string[]
  readonly onModelVisibilityChange: (modelId: string, visible: boolean) => void
  readonly onRemove: (providerId: string) => void
  readonly onRun: RunMutation
}) {
  const providers = useMemo(
    () => reconcileProviderOrder(data.providers, providerOrder),
    [data.providers, providerOrder],
  )
  /* 逐项现 filter 一遍就是 O(供应商 × 模型)，每次重画都付。 */
  const modelsByProvider = useMemo(() => {
    const grouped = new Map<string, ModelDescriptor[]>()
    for (const model of data.models) {
      const held = grouped.get(model.provider)
      if (held === undefined) {
        grouped.set(model.provider, [model])
      } else {
        held.push(model)
      }
    }
    return grouped
  }, [data.models])
  /* 单开是 Base UI 手风琴的默认形态，这里只把它的数组值收成一项。 */
  const [openId, setOpenId] = useState<string | null>(null)
  useEffect(() => {
    if (openId !== null && openId !== ADD_PROVIDER && !providers.some((p) => p.id === openId)) {
      setOpenId(null)
    }
  }, [providers, openId])

  return (
    <div className="models-block">
      <div className="models-provider-head">
        <span className="models-block__label">供应商</span>
        <Button
          onClick={() => setOpenId(openId === ADD_PROVIDER ? null : ADD_PROVIDER)}
          size="xs"
          type="button"
          variant="soft"
        >
          <Plus aria-hidden="true" /> 添加供应商
        </Button>
      </div>
      <div className="models-card">
        <Accordion onValueChange={(next) => setOpenId(next[0] ?? null)} value={openId === null ? [] : [openId]}>
          {openId === ADD_PROVIDER ? (
            <AddProviderItem
              auth={auth}
              data={data}
              disabled={disabled}
              onClose={() => setOpenId(null)}
              onModelVisibilityChange={onModelVisibilityChange}
              onOpen={setOpenId}
              onRun={onRun}
            />
          ) : null}
          {providers.map((provider) => (
            <ProviderItem
              auth={auth}
              disabled={disabled}
              key={provider.id}
              models={modelsByProvider.get(provider.id) ?? []}
              onRemove={() => onRemove(provider.id)}
              onRun={onRun}
              onSaved={() => setOpenId(null)}
              provider={provider}
            />
          ))}
        </Accordion>
        {providers.length === 0 && openId !== ADD_PROVIDER ? (
          <p className="models-empty">还没有供应商，点右上角添加。</p>
        ) : null}
      </div>
    </div>
  )
}

function reconcileProviderOrder(providers: readonly ModelProvider[], preferred: readonly string[]): ModelProvider[] {
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

function ProviderItem({
  auth,
  provider,
  disabled,
  models,
  onRemove,
  onRun,
  onSaved,
}: {
  readonly auth: ProviderAuthSlot
  readonly provider: ModelProvider
  readonly disabled: boolean
  readonly models: readonly ModelDescriptor[]
  readonly onRemove: () => void
  readonly onRun: RunMutation
  readonly onSaved: () => void
}) {
  const custom = provider.providerType === 'custom'
  const method = custom ? null : auth.signedIn(provider.id) ? '账号登录' : 'API Key'
  return (
    <AccordionItem className="models-accordion-item" value={provider.id}>
      <AccordionHeader className="models-accordion-header">
        <AccordionTrigger className="models-accordion-trigger">
          <span className="models-provider-summary">
            <strong>{provider.id}</strong>
            {custom ? <span className="models-provider-pill">自定义</span> : null}
          </span>
          <span className="models-provider-meta">
            <span>{method === null ? `${models.length} 个模型` : `${method} · ${models.length} 个模型`}</span>
            <ChevronDown aria-hidden="true" className="models-provider-chevron" />
          </span>
        </AccordionTrigger>
      </AccordionHeader>
      <AccordionPanel className="models-accordion-panel">
        <div className="models-accordion-panel__inner">
          {custom ? (
            <ProviderForm
              current={{ models, provider }}
              disabled={disabled}
              key={provider.id}
              onDelete={onRemove}
              onRun={onRun}
              onSaved={onSaved}
            />
          ) : (
            <div className="models-builtin">
              {auth.render({ providerId: provider.id, configured: provider.hasApiKey, disabled })}
              <div className="models-builtin__footer">
                <Button disabled={disabled} onClick={onRemove} size="xs" type="button" variant="dangerSoft">
                  移除供应商
                </Button>
              </div>
            </div>
          )}
        </div>
      </AccordionPanel>
    </AccordionItem>
  )
}

type AddMode = 'catalog' | 'manual'

const ADD_MODES = [
  { value: 'catalog', label: '从目录添加' },
  { value: 'manual', label: '手动添加' },
] as const satisfies readonly SegmentedOption<AddMode>[]

function AddProviderItem({
  auth,
  data,
  disabled,
  onClose,
  onModelVisibilityChange,
  onOpen,
  onRun,
}: {
  readonly auth: ProviderAuthSlot
  readonly data: ModelCatalogData
  readonly disabled: boolean
  readonly onClose: () => void
  readonly onModelVisibilityChange: (modelId: string, visible: boolean) => void
  readonly onOpen: (id: string) => void
  readonly onRun: RunMutation
}) {
  const [mode, setMode] = useState<AddMode>('catalog')

  return (
    <AccordionItem className="models-accordion-item" value={ADD_PROVIDER}>
      <AccordionHeader className="models-accordion-header">
        <AccordionTrigger className="models-accordion-trigger">
          <strong>添加供应商</strong>
          <ChevronDown aria-hidden="true" className="models-provider-chevron" />
        </AccordionTrigger>
      </AccordionHeader>
      <AccordionPanel className="models-accordion-panel">
        <div className="models-accordion-panel__inner">
          <SegmentedControl
            className="models-add-modes"
            label="添加方式"
            name="models-add-mode"
            onValueChange={setMode}
            options={ADD_MODES}
            value={mode}
          />
          <div className="models-tab-panel">
            {mode === 'catalog' ? (
              <CatalogAddTab
                auth={auth}
                data={data}
                disabled={disabled}
                onImported={(id) => {
                  onClose()
                  onOpen(id)
                }}
                onModelVisibilityChange={onModelVisibilityChange}
                onRun={onRun}
              />
            ) : null}
            {mode === 'manual' ? (
              <ProviderForm
                disabled={disabled}
                onCancel={onClose}
                onRun={onRun}
                onSaved={(id) => {
                  onClose()
                  onOpen(id)
                }}
              />
            ) : null}
          </div>
        </div>
      </AccordionPanel>
    </AccordionItem>
  )
}

function CatalogAddTab({
  auth,
  data,
  disabled,
  onImported,
  onModelVisibilityChange,
  onRun,
}: {
  readonly auth: ProviderAuthSlot
  readonly data: ModelCatalogData
  readonly disabled: boolean
  readonly onImported: (id: string) => void
  readonly onModelVisibilityChange: (modelId: string, visible: boolean) => void
  readonly onRun: RunMutation
}) {
  const configured = useMemo(() => new Set(data.providers.map((p) => p.id)), [data.providers])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<CatalogProvider | null>(null)
  /* 能用账号登录的排前面：有订阅的人多半是来找它们的 */
  const catalog = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matched = data.catalog.filter(
      (provider) =>
        !configured.has(provider.id) &&
        !provider.rejected &&
        provider.models.length > 0 &&
        (needle === '' || provider.name.toLowerCase().includes(needle) || provider.id.toLowerCase().includes(needle)),
    )
    return [...matched.filter((p) => auth.canSignIn(p.id)), ...matched.filter((p) => !auth.canSignIn(p.id))]
  }, [auth, data.catalog, configured, query])

  if (selected !== null) {
    /* 内置服务商在 omp 里不需要名称和 Base URL：认证一完成就算添加好了 */
    const finish = async () => {
      await onRun({ kind: 'refreshProviders' })
      for (const model of selected.models) {
        onModelVisibilityChange(modelAlias(selected.id, model.id), true)
      }
      onImported(selected.id)
    }
    return (
      <div className="models-add-tab">
        <button className="models-catalog-back" onClick={() => setSelected(null)} type="button">
          <ArrowLeft aria-hidden="true" /> 返回目录列表
        </button>
        <div className="models-add-heading">
          <strong>{selected.name}</strong>
          <span>{selected.models.length} 个模型</span>
        </div>
        {auth.render({
          providerId: selected.id,
          configured: false,
          disabled,
          submitLabel: '添加',
          onAuthorized: finish,
        })}
      </div>
    )
  }

  return (
    <div className="models-add-tab">
      <input
        aria-label="搜索供应商"
        className="settings-input models-search-input"
        onChange={(event) => setQuery(event.target.value)}
        placeholder="搜索供应商"
        type="search"
        value={query}
      />
      <div className="models-catalog-list">
        {catalog.length === 0 ? (
          <p className="models-empty">没有匹配的目录项。</p>
        ) : (
          catalog.map((provider) => (
            <button
              className="models-catalog-row"
              disabled={disabled}
              key={provider.id}
              onClick={() => setSelected(provider)}
              type="button"
            >
              <span className="models-catalog-row__main">
                <strong>{provider.name}</strong>
                {auth.canSignIn(provider.id) ? <span className="models-provider-pill">可账号登录</span> : null}
              </span>
              <span className="models-catalog-row__count">{provider.models.length} 个模型</span>
            </button>
          ))
        )}
      </div>
    </div>
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
      ...(draft.thinkingCapability === null || efforts.length === 0 ? {} : { supportEfforts: efforts }),
      ...(draft.thinkingCapability === null ? {} : { adaptiveThinking: draft.writeFields.adaptiveThinking }),
      ...(draft.displayName.trim() === '' ? {} : { displayName: draft.displayName.trim() }),
    })
  }
  return result.length === 0 ? { ok: false, message: '至少配置一个模型。' } : { ok: true, models: result }
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
  onDelete,
}: {
  readonly current?: ProviderFormCurrent
  readonly disabled: boolean
  readonly onSaved: (id: string) => void
  readonly onRun: RunMutation
  readonly onCancel?: () => void
  readonly onDelete?: () => void
}) {
  const [name, setName] = useState(current?.provider.id ?? '')
  const [providerType, setProviderType] = useState(current?.provider.providerType ?? 'openai')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(current?.provider.baseUrl ?? '')
  const [models, setModels] = useState<ModelDraft[]>(() =>
    current === undefined ? [emptyModel()] : current.models.map((model) => draftFromModel(model, current.provider.id)),
  )
  const [message, setMessage] = useState<string | null>(null)
  const updateModel = (key: string, change: Partial<ModelDraft>) =>
    setModels((value) => value.map((model) => (model.key === key ? { ...model, ...change } : model)))
  const addModel = () => {
    const fresh = emptyModel()
    setModels((value) => [...value, fresh])
  }
  const removeModel = (key: string) => setModels((value) => value.filter((item) => item.key !== key))
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
      <Field htmlFor="provider-form-name" label="名称">
        <input
          aria-required
          className="settings-input"
          id="provider-form-name"
          onChange={(event) => setName(event.target.value)}
          placeholder="my-provider"
          value={name}
        />
      </Field>
      <Field htmlFor="provider-form-base-url" label="Base URL">
        <input
          className="settings-input"
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
        {...(onDelete === undefined ? {} : { onDelete })}
        onRemove={removeModel}
        onUpdate={updateModel}
        {...(onCancel === undefined ? {} : { onCancel })}
      />
    </form>
  )
}

/* 模型列表编辑器：三列直填（模型 ID / 上下文 / 显示名），保存语义不变。 */
function ModelListEditor({
  models,
  disabled,
  message,
  onUpdate,
  onAdd,
  onRemove,
  onCancel,
  onDelete,
}: {
  readonly models: readonly ModelDraft[]
  readonly disabled: boolean
  readonly message: string | null
  readonly onUpdate: (key: string, change: Partial<ModelDraft>) => void
  readonly onAdd: () => void
  readonly onRemove: (key: string) => void
  readonly onCancel?: () => void
  readonly onDelete?: () => void
}) {
  return (
    <div className="models-model-list">
      <span className="models-block__label">
        模型<span className="models-required">*</span>
      </span>
      <div className="models-model-grid">
        <div className="models-model-grid__header">
          <span>
            模型 ID<span className="models-required">*</span>
          </span>
          <span>
            上下文<span className="models-required">*</span>
          </span>
          <span>显示名</span>
          <span />
        </div>
        {models.map((model, index) => {
          const name = model.model.trim() === '' ? `模型 ${String(index + 1)}` : model.model
          return (
            <div className="models-model-grid__row" key={model.key}>
              <input
                aria-label={`${name} ID`}
                className="settings-input"
                onChange={(event) => onUpdate(model.key, { model: event.target.value })}
                placeholder="模型 ID"
                required
                value={model.model}
              />
              <input
                aria-label={`${name}上下文长度`}
                className="settings-input"
                min="1"
                onChange={(event) => onUpdate(model.key, { maxContextSize: event.target.value })}
                placeholder="上下文"
                required
                type="number"
                value={model.maxContextSize}
              />
              <input
                aria-label={`${name}显示名`}
                className="settings-input"
                onChange={(event) => onUpdate(model.key, { displayName: event.target.value })}
                placeholder="可选"
                value={model.displayName}
              />
              <button
                aria-label={`删除${name}`}
                className="models-icon-button"
                disabled={models.length === 1}
                onClick={() => onRemove(model.key)}
                type="button"
              >
                <Trash2 aria-hidden="true" />
              </button>
            </div>
          )
        })}
      </div>
      <div className="models-model-grid__add">
        <Button onClick={() => onAdd()} size="xs" type="button" variant="soft">
          <Plus aria-hidden="true" /> 添加模型
        </Button>
      </div>
      <span aria-live="polite" className="models-model-message">
        {message}
      </span>
      <div className="models-model-footer">
        {onDelete === undefined ? null : (
          <Button onClick={onDelete} size="xs" type="button" variant="dangerSoft">
            删除供应商
          </Button>
        )}
        <span className="models-model-footer__spacer" />
        {disabled ? <InlineSpinner /> : null}
        {onCancel === undefined ? null : (
          <Button onClick={onCancel} size="xs" type="button" variant="ghost">
            取消
          </Button>
        )}
        <Button disabled={disabled} size="xs" type="submit" variant="soft">
          {disabled ? '正在保存…' : onDelete === undefined ? '添加供应商' : '保存'}
        </Button>
      </div>
    </div>
  )
}

function Field({
  label,
  htmlFor,
  children,
}: {
  readonly label: ReactNode
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
