import { agent } from '@poietica/agent-catalog'
import {
  Button,
  ConfirmationDialog,
  InlineSpinner,
  Select,
  type SelectOption,
} from '@poietica/design-system'
import type { AgentSettings, CatalogProvider, ModelCatalogStore } from '@poietica/settings'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { describeAgentCliFailure } from '../agent-install/agent-cli-text'
import { AgentInstallAction } from '../agent-install/agent-install-action'
import './models-settings.css'

/*
 * 设置 · 模型。
 *
 * 这一页没有「保存」：默认模型、provider 与密钥的真身都在 agent 进程（经 kap 的
 * providers REST 读写），ModelCatalogStore 是它在这个渲染进程里的唯一投影。
 * 界面显示的就是 agent 此刻的真实配置，写的每一笔 mutate 立刻落到它那边。
 */

export interface ModelsSettingsProps {
  readonly store: AgentSettings
  readonly modelCatalog: ModelCatalogStore
}

export function ModelsSettings({ store, modelCatalog }: ModelsSettingsProps) {
  const [agentError, setAgentError] = useState<string | null>(null)

  /*
   * 读一次落盘的配置。这一趟唯一的产出是「配置里有什么没能用上」：档案本身由 store
   * 在这次读取里物化，界面不持有它的副本。
   *
   * active 标志防的是两次往返先后颠倒，不是「卸载后 setState」。
   */
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

/*
 * mutate 失败由 store 原样抛出（同时记进快照），这里接住转成一行给用户的话。
 * actionError 与快照上的 error 不是两份状态：后者说的是「读目录失败」，这里说的
 * 是「这一次写失败」，读者不同。
 */
function ModelCatalogPanel({ store }: { readonly store: ModelCatalogStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [actionError, setActionError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)

  useEffect(() => {
    void store.refresh()
  }, [store])

  const run = (operation: Parameters<ModelCatalogStore['mutate']>[0]) => {
    setActionError(null)
    void store
      .mutate(operation)
      .catch((cause: unknown) =>
        setActionError(describeAgentCliFailure(cause, '模型目录写入失败，请重试。')),
      )
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
    return <p className="models-empty">正在读取模型目录…</p>
  }

  const { data } = snapshot
  /* 同一模型 id 可能被多家 provider 报上来，下拉的值只留第一处。 */
  const modelOptions: SelectOption[] = []
  const seen = new Set<string>()
  for (const descriptor of data.models) {
    if (seen.has(descriptor.model)) {
      continue
    }
    seen.add(descriptor.model)
    modelOptions.push({
      value: descriptor.model,
      label: descriptor.displayName ?? descriptor.model,
    })
  }
  /* Select 的值必须落在选项里：默认模型尚未落位时补一行「未设置」占位。 */
  const defaultOptions =
    data.defaultModel === null ? [{ value: '', label: '未设置' }, ...modelOptions] : modelOptions

  const configuredIds = new Set(data.providers.map((provider) => provider.id))
  const addable = data.catalog.filter((provider) => !configuredIds.has(provider.id))

  return (
    <>
      {modelOptions.length > 0 ? (
        <div className="models-block">
          <span className="models-block__label">默认模型</span>

          <div className="models-card">
            <div className="models-row models-row--compact">
              <div className="models-row__copy">
                <p>新对话开口时用的那一个，agent 那边即刻生效</p>
              </div>

              <div className="models-row__control">
                {snapshot.mutating ? <InlineSpinner /> : null}
                <Select
                  align="end"
                  className="models-select-trigger"
                  data={defaultOptions}
                  onValueChange={(modelId) => {
                    if (modelId !== '') {
                      run({ kind: 'setDefault', modelId })
                    }
                  }}
                  type="默认模型"
                  value={data.defaultModel ?? ''}
                />
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {actionError !== null ? <p className="models-notice">{actionError}</p> : null}

      <div className="models-block">
        <span className="models-block__label">已配置的服务商</span>

        <div className="models-card models-card--list">
          {data.providers.length === 0 ? (
            <p className="models-empty">还没有服务商，从下面的目录里添加一个。</p>
          ) : (
            data.providers.map((provider) => (
              <div className="models-row" key={provider.id}>
                <div className="models-row__copy">
                  <span className="models-row__name">{provider.id}</span>
                  <p>
                    {provider.hasApiKey ? '密钥已配置' : '未配置密钥'}
                    {provider.models !== null ? ` · ${provider.models.length} 个模型` : ''}
                  </p>
                </div>

                <div className="models-row__control">
                  <Button
                    className="models-button-danger"
                    disabled={snapshot.mutating}
                    onClick={() => setRemoving(provider.id)}
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

      <CatalogSection
        catalog={addable}
        mutating={snapshot.mutating}
        onImport={(provider, apiKey, baseUrl) =>
          run({
            kind: 'importCatalog',
            catalogId: provider.id,
            ...(apiKey !== '' ? { apiKey } : {}),
            ...(baseUrl !== undefined && baseUrl !== '' ? { baseUrl } : {}),
          })
        }
      />

      <ConfirmationDialog
        busy={snapshot.mutating}
        confirmLabel="删除"
        description={`删除 ${removing ?? ''} 后，它的模型与密钥一起从 agent 配置里移除。`}
        destructive
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing !== null) {
            run({ kind: 'delete', providerId: removing })
          }
          setRemoving(null)
        }}
        open={removing !== null}
        title="删除这个服务商？"
      />
    </>
  )
}

/*
 * 目录里可添加的服务商：搜一个，填密钥（需要的话再填地址），提交即生效。
 * 搜索词只过滤这一张表，不进 store —— 它是这个面板的瞬时视图，不是领域状态。
 */
function CatalogSection({
  catalog,
  mutating,
  onImport,
}: {
  readonly catalog: readonly CatalogProvider[]
  readonly mutating: boolean
  readonly onImport: (provider: CatalogProvider, apiKey: string, baseUrl?: string) => void
}) {
  const [query, setQuery] = useState('')
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') {
      return catalog
    }
    return catalog.filter(
      (provider) =>
        provider.id.toLowerCase().includes(needle) || provider.name.toLowerCase().includes(needle),
    )
  }, [catalog, query])

  if (catalog.length === 0) {
    return null
  }

  return (
    <div className="models-block">
      <span className="models-block__label">添加服务商</span>

      <div className="models-card models-card--list">
        <div className="models-toolbar">
          <input
            aria-label="搜索服务商"
            className="models-input models-input--search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索服务商…"
            type="search"
            value={query}
          />
        </div>

        {shown.length === 0 ? (
          <p className="models-empty">目录里没有匹配「{query.trim()}」的服务商。</p>
        ) : (
          shown.map((provider) => (
            <CatalogRow
              key={provider.id}
              mutating={mutating}
              onImport={onImport}
              provider={provider}
            />
          ))
        )}
      </div>
    </div>
  )
}

/*
 * 一行一家：默认只有名字与模型数，点「添加」就地展开密钥输入。
 * 填完即提交、提交后清空并收起 —— 密钥从不回填，所以密码框的显隐按钮（Edge 注入
 * 的那几颗）在 CSS 里整个关掉（见 models-settings.css）。
 */
function CatalogRow({
  provider,
  mutating,
  onImport,
}: {
  readonly provider: CatalogProvider
  readonly mutating: boolean
  readonly onImport: (provider: CatalogProvider, apiKey: string, baseUrl?: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')

  const submit = () => {
    onImport(provider, apiKey.trim(), provider.needsBaseUrl ? baseUrl.trim() : undefined)
    setApiKey('')
    setBaseUrl('')
    setOpen(false)
  }

  return (
    <>
      <div className="models-row">
        <div className="models-row__copy">
          <span className="models-row__name">{provider.name}</span>
          <p>
            {provider.id} · {provider.models.length} 个模型
          </p>
        </div>

        <div className="models-row__control">
          <Button
            disabled={mutating}
            onClick={() => setOpen((current) => !current)}
            size="xs"
            type="button"
            variant="soft"
          >
            {open ? '收起' : '添加'}
          </Button>
        </div>
      </div>

      {open ? (
        <div className="models-row models-row--field">
          <input
            aria-label={`${provider.name} 的 API 密钥`}
            autoComplete="off"
            className="models-input"
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="API 密钥"
            type="password"
            value={apiKey}
          />

          {provider.needsBaseUrl ? (
            <input
              aria-label={`${provider.name} 的服务地址`}
              className="models-input"
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="服务地址（base URL）"
              type="url"
              value={baseUrl}
            />
          ) : null}

          <div className="models-row__control">
            <Button
              disabled={mutating || apiKey.trim() === ''}
              onClick={submit}
              size="xs"
              type="button"
            >
              保存
            </Button>
          </div>
        </div>
      ) : null}
    </>
  )
}
