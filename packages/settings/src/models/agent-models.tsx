import {
  type AgentCatalogCodec,
  type AgentModelState,
  type AgentProviderSnapshot,
  acpAgentById,
  agentCatalogCodec,
  agentModelDisplayName,
  builtinAgentProviders,
  parseAgentProviderListOutput,
} from '@poietica/agent-catalog'
import { Button, InlineSpinner } from '@poietica/ui'
import { LoaderCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentConfigStore } from '../agent-config-store'
import { describeAgentCliFailure, describeAgentCliOutcome } from '../agent-install/agent-cli-text'
import { ProviderKeyCard } from './provider-key-card'
import { useAgentProviders } from './use-agent-providers'

/*
 * 一家 agent 的模型页。
 *
 * 这里的每一格状态都只对一家 agent 成立：它报回来的模型、它的密钥尾号、从全局配置
 * 探到的待导入清单、正在删哪一行、搜索词、展开与否。换一家 agent，它们全部作废。
 *
 * 作废由 React 自己做：外壳以 key={agentId} 挂载这棵子树（官方文档 Preserving and
 * Resetting State 里 "Resetting state with a key" 的原样用法）。此前这些状态与外壳
 * 挤在一个组件里，换 agent 只改一个字符串，于是：
 *
 * - 在 A 上「导入配置」探出一份清单，切到 B，那条横幅仍在屏幕上；点「确认导入」时
 *   runImport 读的是当前的 agentId（B），喂的却是 A 的 globalSnapshot —— 把 A 的
 *   provider 导进 B；
 * - keyTails、confirmId、importNote 同理，都会跨 agent 留在屏幕上。
 *
 * 三套手写的「过期响应」防护也在这里退场两套：卡片里的 mounted ref 拦的是卸载，拦不住
 * 上面这些（那时组件根本没卸载）；外壳里的 active 标志同理。整棵子树重建之后，在飞的
 * 回执落在已卸载的树上，React 自己丢掉。留下的只有 keyTails 那一处 ignore 标志 ——
 * 它防的是同一棵树内两次往返的先后颠倒，key 管不到那件事。
 */

/*
 * 折叠时显示多少条。
 *
 * 这个数字不能等于任何一份数据的长度。上一版它是 11，而写死的目录恰好 11 项，于是
 * 展开与折叠返回同一个数组，「查看全部模型」点了不动。
 */
const COLLAPSED_MODEL_LIMIT = 8

/* 要显示哪几家。清单内置在 @poietica/agent-providers 的 provider-presets.ts 里。 */
const BUILTIN_PROVIDERS = builtinAgentProviders()

/** 一家没导进去，以及 agent 说的原因。 */
interface ImportFailure {
  readonly id: string
  readonly reason: string
}

/*
 * agent 拒绝这一次写入时说了什么。
 *
 * 上游每一条失败路径都先往 stderr 写一行再退出，所以第一行非空就是全部原因。原文直出
 * 不改写：那一行指得到地方，而一句读着体面的「导入失败」指不到任何地方。
 *
 * stderr 空就退回 stdout —— 有些失败是 commander 层打印的；两样都空时只剩退出码，那也
 * 比不说强。
 */

/*
 * 导入一家 provider。
 *
 * 这里只回答一个问题：这一家成了没有。成了是 undefined，没成是一条带着对方原话的失败 ——
 * 不抛异常，因为「一家没导进去」是调用方要逐条说给用户听的结果，不是意外。
 */
async function importOne(input: {
  readonly agentId: string
  readonly codec: AgentCatalogCodec
  readonly defaultModelId: string | undefined
  readonly provider: AgentProviderSnapshot['providers'][number]
  readonly registryKeyVar: string
  readonly store: AgentConfigStore
}): Promise<ImportFailure | undefined> {
  const { agentId, codec, defaultModelId, provider, registryKeyVar, store } = input

  try {
    const outcome = await store.execCli({
      agentId,
      args: codec.catalogAddArgs({
        providerId: provider.id,
        ...(defaultModelId === undefined ? {} : { defaultModelId }),
        ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
      }),
      secretVar: registryKeyVar,
      catalogDocument: codec.importDocument(provider),
      secretFromGlobalProvider: provider.id,
    })

    return outcome.status === 0
      ? undefined
      : { id: provider.id, reason: describeAgentCliOutcome(outcome) }
  } catch (cause: unknown) {
    return { id: provider.id, reason: describeAgentCliFailure(cause, '调用失败') }
  }
}

export interface AgentModelsProps {
  readonly store: AgentConfigStore
  readonly agentId: string
  /** 档案声明的注入变量名。缺席时不写入，而不是自己挑一个名字。 */
  readonly registryKeyVar: string | undefined
}

/*
 * 这里只画随所选 agent 一起作废的东西 —— 那正是外壳用 key 圈起来的范围。
 *
 * 选 agent 的下拉与「智能体」那张卡都跨 agent，搬回外壳了：它们此前渲染在这棵子树
 * 里，而这棵子树正是它们自己按一下就会重建的那一棵。
 */
export function AgentModels({ store, agentId, registryKeyVar }: AgentModelsProps) {
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [probing, setProbing] = useState(false)
  const [globalSnapshot, setGlobalSnapshot] = useState<AgentProviderSnapshot | undefined>(undefined)
  const [globalNote, setGlobalNote] = useState<string | null>(null)
  const [keyTails, setKeyTails] = useState<Readonly<Partial<Record<string, string>>>>({})
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [keyError, setKeyError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [importNote, setImportNote] = useState<string | null>(null)

  const providers = useAgentProviders(store, agentId)

  /*
   * 动过 agent 的配置之后，把「我改了」说出去，仅此一句。
   *
   * 听众里包括进程里其他照着同一份配置建了内存副本的地方 —— 主界面工具条上那个模型
   * 选择器就是其中之一，它此前一个进程只读一次，于是导入完成、这一页立刻列出五个模型，
   * 主界面却要等到下次启动才长出选择器 —— 也包括这一页自己（下面那个订阅）。
   *
   * 此前这里是「本页重读 + 广播」两件事并排做的，于是重读只发生在记得调它的那几个调用
   * 点上。ACP Agent 那一行的安装 / 更新不在这棵子树里，够不着这个函数，装完新版 CLI 之后
   * 清单还是旧版报回来的。改配置的地方只会越来越多，要求每一处都记得重读一次就是留债。
   */
  const announceConfigChanged = useCallback(() => {
    store.notifyConfigChanged()
  }, [store])

  /* 本页也是听众之一 —— 不管这次改动是从这棵子树里发起的，还是从外面。 */
  useEffect(() => store.subscribeConfigChanged(providers.reload), [providers.reload, store])

  /*
   * 一次性导入的第一步：对用户全局 home 跑一次只读的 provider list，把将导入的内容
   * 摆出来。确认后的写入在 runImport，按 provider 逐家走官方命令。
   */
  const probeGlobalHome = useCallback(() => {
    if (probing) {
      return
    }

    /* 问什么写在档案里。在这里再抄一遍，就是第二个迟早走样的说法。 */
    const descriptor = acpAgentById(agentId)

    if (descriptor === undefined) {
      setGlobalSnapshot(undefined)
      setGlobalNote(`没有登记 ${agentId} 这个 agent 的接入档案。`)

      return
    }

    /* 与 useAgentProviders 同一条判据：可选就是可选，缺席不发这次调用。 */
    const listArgs = descriptor.providerListArgs

    if (listArgs === undefined) {
      setGlobalSnapshot(undefined)
      setGlobalNote(`${descriptor.displayName} 没有声明查询模型清单的子命令。`)

      return
    }

    setProbing(true)

    void store
      .execCli({
        agentId,
        args: [...listArgs],
        useGlobalHome: true,
      })
      .then(
        (outcome) => {
          setProbing(false)

          if (outcome.status !== 0) {
            setGlobalSnapshot(undefined)
            setGlobalNote('读取全局配置失败。')
            return
          }

          const snapshot = parseAgentProviderListOutput(
            outcome.stdout,
            descriptor.syntheticProviderId,
          )
          const usable = snapshot.providers.filter((provider) => !provider.synthetic)

          setGlobalSnapshot(usable.length > 0 ? { ...snapshot, providers: usable } : undefined)
          setGlobalNote(
            usable.length > 0
              ? null
              : '全局配置里没有可识别的 provider（OAuth 登录的账号不在其中）。',
          )
        },
        () => {
          setProbing(false)
          setGlobalSnapshot(undefined)
          setGlobalNote('读取全局配置失败。')
        },
      )
  }, [agentId, probing, store])

  /*
   * 确认导入：一家一家走官方的 provider catalog add。
   *
   * 不是整份复制 config.toml —— 那件事的前提（受控 home 里现有的都不重要）在任何一台
   * 已配置过的机器上都是假的。官方语义里写入的原子单位本来就是 provider。
   *
   * 目录由这一家在全局配置里的模型清单现场序列化，密钥由原生侧从全局 config.toml 取出
   * 直达子进程 —— 两样都不进渲染层，与厂商卡那条写入是同一条管线。
   *
   * 只导已配置密钥的那几家：没有密钥的取不到 api_key，catalog add 必然失败。
   */
  const runImport = useCallback(() => {
    if (importing || globalSnapshot === undefined) {
      return
    }

    if (registryKeyVar === undefined) {
      setImportNote('这个 agent 没有声明该往哪个环境变量注入密钥，无法导入。')
      return
    }

    /*
     * 目录写成什么形状归这一家的编解码器。缺席就是"说不出"，于是这次导入不发生 ——
     * 与上面那条判据同构，也是我们对"这一家不支持"的统一处置。
     */
    const codec = agentCatalogCodec(agentId)

    if (codec === undefined) {
      setImportNote('这个 agent 没有声明该怎么写入 provider 目录，无法导入。')
      return
    }

    const usable = globalSnapshot.providers.filter((provider) => provider.configured)

    if (usable.length === 0) {
      setImportNote('全局配置里没有带密钥的 provider 可导入。')
      return
    }

    /*
     * 谁来定 default_model。
     *
     * 顶层没有这一行，ACP 的鉴权闸门第一条就判死，配置文件里的密钥整条不算数。上游只在
     * 旧值还解析得出来时才恢复它（handleCatalogAdd 的 stillResolves）—— 删干净重来的机器
     * 上没有旧值可恢复，于是导完一切都对，就是开不了会话。
     *
     * 只给第一家带：后面几家不带参数时，上游会把刚写进去的这个值原样恢复。每家都带只会
     * 让最后一家赢，那是随机，不是选择。
     */
    const defaultModelOwner = usable.find(
      (provider) => codec.defaultModelId(provider) !== undefined,
    )

    setImporting(true)
    setImportNote(null)

    const importAll = async (): Promise<readonly ImportFailure[]> => {
      const failed: ImportFailure[] = []

      /* 一家失败也不中断 —— 逐家记名，最后一次说清楚。 */
      for (const provider of usable) {
        const failure = await importOne({
          agentId,
          codec,
          defaultModelId:
            provider === defaultModelOwner ? codec.defaultModelId(provider) : undefined,
          provider,
          registryKeyVar,
          store,
        })

        if (failure !== undefined) {
          failed.push(failure)
        }
      }

      return failed
    }

    void importAll().then(
      (failed) => {
        setImporting(false)
        setImportNote(
          failed.length === 0
            ? `已导入 ${usable.length} 家 provider。`
            : `已导入 ${usable.length - failed.length} 家。` +
                failed.map((one) => `${one.id}：${one.reason}`).join('；'),
        )
        setGlobalSnapshot(undefined)
        setGlobalNote(null)
        announceConfigChanged()
      },
      (cause: unknown) => {
        setImporting(false)
        setImportNote(describeAgentCliFailure(cause, '导入失败，请重试。'))
      },
    )
  }, [agentId, globalSnapshot, importing, announceConfigChanged, registryKeyVar, store])

  /* agent 报回来的模型，拍平成一列。分组信息留在每一行的右侧小字里。 */
  const allModels = useMemo(() => {
    return providers.snapshot?.providers.flatMap((provider) => provider.models) ?? []
  }, [providers.snapshot])

  const visibleModels = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    const matched = keyword
      ? allModels.filter((model) => model.displayName.toLowerCase().includes(keyword))
      : allModels
    return showAll || keyword ? matched : matched.slice(0, COLLAPSED_MODEL_LIMIT)
  }, [allModels, query, showAll])

  const providerSnapshot = providers.snapshot

  /*
   * 密钥尾号只读现算：与「写经谁手」无关，官方 CLI 配置的也有。
   *
   * 快照变化时重取一次：保存与删除都会引起快照变化，所以不需要额外的失效逻辑。
   *
   * 这个 ignore 标志是这一页仅剩的一处，而且是必要的：同一棵树里两次往返可能先后颠倒，
   * 换 agent 那条路由 key 管，这条路 key 管不到（React 官方 Synchronizing with Effects
   * 里的原样写法）。
   */
  useEffect(() => {
    if (providerSnapshot === undefined) {
      setKeyTails({})
      return
    }

    let active = true

    void store.loadKeyTails(agentId).then(
      (tails) => {
        if (active) {
          setKeyTails(tails)
        }
      },
      () => {
        if (active) {
          setKeyTails({})
        }
      },
    )

    return () => {
      active = false
    }
  }, [agentId, providerSnapshot, store])

  /* agent 自己报的配置问题。它比我们更清楚哪一条坏了。 */
  const providerIssues = useMemo(() => {
    const issues = providers.snapshot?.issues ?? []

    return issues.length > 0 ? issues.join('；') : null
  }, [providers.snapshot])

  /*
   * 列表位置该显示什么。
   *
   * 四种情况算在一处而不是在 JSX 里套三层三元：出错、正在问、一个模型都没配、筛没了。
   * 返回 null 表示该画列表。
   */
  const modelListMessage = useMemo(() => {
    if (providers.error !== null) {
      return providers.error
    }

    if (providers.loading) {
      return '正在读取模型清单…'
    }

    if (allModels.length === 0) {
      return '这个 agent 还没有配置任何模型。填入密钥、保存之后这里会列出它报回来的模型。'
    }

    if (visibleModels.length === 0) {
      return '没有匹配的模型。'
    }

    return null
  }, [allModels.length, providers.error, providers.loading, visibleModels.length])

  /*
   * 「API 密钥」列表的行：agent 报回来的已配置 provider，各配一行。
   *
   * 行不来自 keyTails：那份表只是尾号备忘，「配没配过」的答案只有一个产地 ——
   * provider list 的快照。环境变量合成的保留条目不出现在这里：它不是用户配的。
   */
  const configuredKeyRows = useMemo(() => {
    const rows: Array<{ id: string; label: string; hint: string }> = []

    for (const provider of providers.snapshot?.providers ?? []) {
      if (!provider.configured || provider.synthetic) {
        continue
      }

      const tail = keyTails[provider.id]
      const label =
        BUILTIN_PROVIDERS.find((preset) => preset.id === provider.id)?.displayName ?? provider.id

      rows.push({
        id: provider.id,
        label,
        hint: tail === undefined ? '取不到尾号' : `•••••${tail}`,
      })
    }

    return rows
  }, [keyTails, providers.snapshot])

  /*
   * 删除就是官方 CLI 的 provider remove：provider 与它的全部模型别名一起消失，默认模型
   * 若指着它也会被对方清空。没有回收站 —— 所以删除是两步。
   *
   * 删完不再重读 agents.json：这条命令改的是 agent 自己的 config.toml，而那次读取取回
   * 的是接入档案，与刚删掉的 provider 没有关系，拿不到任何新东西。失败的话说在这一块
   * 里，而不是顶上那张与它无关的「ACP Agent」卡片的副标题上。
   */
  const removeKey = useCallback(
    (providerId: string) => {
      if (deletingId !== null) {
        return
      }

      setDeletingId(providerId)
      setKeyError(null)

      void store
        .execCli({
          agentId,
          args: ['provider', 'remove', providerId],
        })
        .then(
          (outcome) => {
            setDeletingId(null)
            setConfirmId(null)

            if (outcome.status !== 0) {
              setKeyError(describeAgentCliOutcome(outcome))
              return
            }

            announceConfigChanged()
          },
          (cause: unknown) => {
            setDeletingId(null)
            setKeyError(describeAgentCliFailure(cause, '删除失败，请重试。'))
          },
        )
    },
    [agentId, deletingId, announceConfigChanged, store],
  )

  return (
    <>
      <p className="models-notice models-notice--bar">
        <span>模型清单来自内置名单，也支持从配置文件中反向导入</span>

        <Button disabled={probing} onClick={probeGlobalHome} size="xs" type="button" variant="soft">
          {probing ? '正在读取…' : '导入配置'}
        </Button>
      </p>

      {globalNote !== null ? <p className="models-empty">{globalNote}</p> : null}

      {globalSnapshot !== undefined ? (
        <p className="models-notice models-notice--bar">
          <span>
            在你电脑的全局配置里发现：
            {globalSnapshot.providers
              .map((provider) => {
                const state = provider.configured ? '已配置密钥' : '未配置密钥'
                return `${provider.id}（${provider.models.length} 个模型，${state}）`
              })
              .join('；')}
          </span>

          <Button disabled={importing} onClick={runImport} size="xs" type="button" variant="soft">
            {importing ? '正在导入…' : '确认导入'}
          </Button>
        </p>
      ) : null}

      {importNote !== null ? <p className="models-empty">{importNote}</p> : null}

      {/*
       * 下面那份清单是上一次读到的。它继续显示 —— 那仍是 agent 片刻前的真实配置 ——
       * 但不能让它冒充这一刻的事实：刚按过刷新、刚删过一个 provider 的人，有权知道
       * 屏幕为什么没动。
       */}
      {/*
       * agent 自己报回来的配置问题，说在它的清单旁边。
       *
       * 此前它和 agents.json 的错误挤在「ACP Agent」那张卡的副标题里三选一 ——
       * 两个来源、一个位置，谁盖住谁全看当时哪一个不是 null。
       */}
      {providerIssues !== null ? <p className="models-notice">{providerIssues}</p> : null}

      {providers.refreshError !== null ? (
        <p className="models-notice">
          下面这份清单是上一次读到的 —— 这一次重读没成：{providers.refreshError}
        </p>
      ) : null}

      <div className="models-card models-card--list">
        <div className="models-toolbar">
          <input
            aria-label="搜索模型"
            className="models-input models-input--search"
            onChange={(event) => {
              setQuery(event.target.value)
            }}
            placeholder="搜索模型"
            type="text"
            value={query}
          />

          <button
            aria-label="重新读取模型清单"
            className="models-icon-button"
            onClick={providers.reload}
            type="button"
          >
            <LoaderCircle aria-hidden="true" className="models-icon" size={16} strokeWidth={1.7} />
          </button>
        </div>

        <div className="models-list">
          {modelListMessage !== null ? (
            <p className="models-empty">{modelListMessage}</p>
          ) : (
            visibleModels.map((model) => <ModelRow key={model.alias} model={model} />)
          )}
        </div>

        {allModels.length > COLLAPSED_MODEL_LIMIT ? (
          <button
            className="models-link"
            onClick={() => {
              setShowAll((current) => !current)
            }}
            type="button"
          >
            {showAll ? '收起模型列表' : '查看全部模型'}
          </button>
        ) : null}
      </div>

      <section className="models-keys">
        <h2 className="models-keys__title">API 配置</h2>

        <div className="models-keys__body">
          {BUILTIN_PROVIDERS.map((preset) => (
            <ProviderKeyCard
              agentId={agentId}
              key={preset.id}
              onSaved={announceConfigChanged}
              provider={preset}
              registryKeyVar={registryKeyVar}
              store={store}
            />
          ))}

          <div className="models-block">
            <span className="models-block__label">API 密钥</span>

            {keyError !== null ? <p className="models-empty">{keyError}</p> : null}

            {configuredKeyRows.length > 0 ? (
              <div className="models-card">
                {configuredKeyRows.map((row) => (
                  <div className="models-row models-row--compact" key={row.id}>
                    <span className="models-row__name">{row.label}</span>

                    <div className="models-row__control">
                      <span className="models-row__meta">{row.hint}</span>

                      {confirmId === row.id ? (
                        <>
                          {deletingId !== row.id ? (
                            <Button
                              onClick={() => {
                                setConfirmId(null)
                              }}
                              size="xs"
                              type="button"
                              variant="soft"
                            >
                              取消
                            </Button>
                          ) : null}

                          {deletingId === row.id ? <InlineSpinner /> : null}

                          <Button
                            className="models-button-danger"
                            disabled={deletingId !== null}
                            onClick={() => {
                              removeKey(row.id)
                            }}
                            size="xs"
                            type="button"
                            variant="soft"
                          >
                            {deletingId === row.id ? '正在删除' : '确认删除'}
                          </Button>
                        </>
                      ) : (
                        <Button
                          className="models-button-danger"
                          onClick={() => {
                            setConfirmId(row.id)
                          }}
                          size="xs"
                          type="button"
                          variant="soft"
                        >
                          删除
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="models-empty">还没有已配置的密钥。</p>
            )}
          </div>
        </div>
      </section>
    </>
  )
}

interface ModelRowProps {
  readonly model: AgentModelState
}

/*
 * 一行模型。
 *
 * 右侧没有开关。agent 报回来的模型就是它此刻能用的模型，我们这边拨一下不会让它多一个
 * 或少一个；上一版那个开关拨了确实什么也没发生。
 */
function ModelRow({ model }: ModelRowProps) {
  return (
    <div className="models-row models-row--compact">
      <span className="models-row__name">{agentModelDisplayName(model)}</span>

      <div className="models-row__control">
        <span className="models-row__meta">{describeModel(model)}</span>
      </div>
    </div>
  )
}

/* 右侧那行小字：谁提供的，能装多少。取不到就留空，不编。 */
function describeModel(model: AgentModelState): string {
  const parts: string[] = []

  if (model.providerId !== undefined) {
    parts.push(model.providerId)
  }

  if (model.maxContextSize !== undefined) {
    parts.push(`${Math.round(model.maxContextSize / 1000)}K 上下文`)
  }

  return parts.join(' · ')
}
