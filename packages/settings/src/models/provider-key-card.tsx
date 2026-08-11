import {
  type AgentCatalogCodec,
  type AgentProviderPreset,
  agentCatalogCodec,
} from '@poietica/agent-catalog'
import { Button, InlineSpinner } from '@poietica/ui'
import { useCallback, useEffect, useState } from 'react'
import type { AgentConfigStore, ProviderKeyProbe } from '../agent-config-store'
import { describeAgentCliFailure, describeAgentCliOutcome } from '../agent-install/agent-cli-text'
import { SubField } from './models-fields'

/*
 * 一家厂商的凭据卡。传进来的是 builtinAgentProviders 的一条。
 *
 * 上一版这张卡开开关就起一个子进程，问 agent「这家有哪些模型」。那条路作废了：agent 的
 * 目录命令每次都要现拉 models.dev，拉不到就直接失败，没有内置兜底。候选模型改成内置表，
 * 于是一打开这张卡就有清单 —— 不起进程、离线也有、也没有那句「正在询问…」。
 *
 * 开关本身也删了：它只决定表单显不显示，没有任何真语义（配没配过写在 agent 那边，
 * 拨它不改变任何事实）。一个拨了什么都不改变的控件是仪式，不是功能。
 *
 * 手填「基础地址」那一格删了。接口地址属于厂商身份，内置就够；Zed 也不把它放进密钥
 * 界面（api_url() 从设置里读，空则用常量）。真要改地址的场景是自建网关，那是另一类
 * provider，不该让每个填密钥的人都先看见一个空框。
 *
 * 「默认模型」那一格也删了，它搬去了这一页的顶层。配置里 default_model 是顶层唯一的一个
 * 键，一家一格必然有两格在说假话；而且那一格从不读配置、只在提交密钥的瞬间才有效，配好
 * 之后再拨它没有任何动作。Zed 的 AgentSettings 上也只有一个 default_model。
 *
 * 这张卡因此只剩它真正拥有的东西：这一家的密钥。
 *
 * 密钥不上命令行、不落我们的盘：随一次 execCli 经环境变量进子进程，写进 agent 自己的
 * 配置之后就与我们无关 —— 包括「配没配过」，答案在上面那张模型列表里。
 *
 * 写入走 agent 的 catalog add。它的目录只吃一个 http(s) 地址，默认目录 models.dev 在
 * 部分网络下不可达 —— 所以目录由我们自己供：把这家厂商的内置表按 api.json 形状序列化，
 * 随 execCli 交给原生侧，绑在一次性 loopback 服务上，用官方的 --url 喂给它。全程不碰
 * 外网、不解析对方的配置文件。
 */
/*
 * 多久算「慢」。到点不停动画 —— 停下来才是撒谎的那一半：写入其实还在跑，界面却说完了 ——
 * 而是多说一句实话。
 *
 * 这一次往返要起一个 Node 进程跑 agent 的 provider catalog add，进程启动是它的大头，
 * 正常几秒；到 8 秒还没回来，用户有权知道它卡在哪一步。
 */
const SLOW_WRITE_MS = 8000

/*
 * 一次探测的结论怎么说。
 *
 * 五种结论，只有一种说「密钥不对」。这不是措辞讲究，是判据本身：401 之外的任何
 * 一种都无法排除「密钥其实是对的」，说死了就是软件在撒谎。所以其余四种一律说
 * 「未验证」，并把真正的怀疑对象指出来（端点、网络、权限）。
 *
 * 只有 rejected 那一句说的是「没写」—— 它是唯一一个在写入之前就把这次提交拦下来的
 * 结论。其余四句都以「已写入」开头，因为它们都不构成拒绝的理由。
 */
function describeKeyVerdict(probe: ProviderKeyProbe, vendor: string): string {
  switch (probe.verdict) {
    case 'accepted':
      return '密钥已验证，并写入 agent 自己的配置。'
    case 'rejected':
      return `${vendor} 不认这把密钥（HTTP 401），没有写入。请核对后重新填写。`
    case 'forbidden':
      return `密钥有效，已写入；但这个账号在 ${vendor} 没有访问权限（HTTP 403）。`
    case 'unsupported':
      return '已写入 agent 自己的配置。这家没有提供可用于校验的端点，密钥未验证。'
    default:
      return '已写入 agent 自己的配置。没能连上厂商接口（可能是网络或代理），密钥未验证。'
  }
}

export interface ProviderKeyCardProps {
  readonly store: AgentConfigStore
  readonly agentId: string
  readonly provider: AgentProviderPreset
  /** 档案声明的注入变量名。缺席时不写入，而不是自己挑一个名字。 */
  readonly registryKeyVar: string | undefined
  readonly onSaved: () => void
}

export function ProviderKeyCard({
  store,
  agentId,
  provider,
  registryKeyVar,
  onSaved,
}: ProviderKeyCardProps) {
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [waited, setWaited] = useState(false)

  /*
   * 上一次的回执不该压在下一次的输入上：一动密钥，那句话就作废。
   *
   * 此前只有 submit 里清一次，于是「已写入 agent 自己的配置。」会和一个刚填了
   * 一半的新密钥同框 —— 那句话说的是上一次。
   */
  const editKey = useCallback((next: string) => {
    setApiKey(next)
    setMessage(null)
  }, [])

  /*
   * 这里没有「卸载后不 setState」那道守卫。
   *
   * React 18 起「卸载后 setState」不再是错误，那条警告本身已被官方删掉
   * （facebook/react#22114）。而它真该防的那件事它也防不住：这张卡的 key 是
   * provider id，换 agent 时组件不重建，于是在 A 上按下保存、立刻切到 B，回执会
   * 落在 B 的界面上 —— 那一刻组件还挂着，任何按卸载判断的守卫都会放行。换 agent
   * 的作废由外壳的 key={agentId} 整棵重建来做，见 AgentModels。
   */

  /*
   * 忙碌指示的唯一驱动是 busy，而 busy 只在 execCli 这一次真实往返期间为真：没有假进度、
   * 没有最小展示时长、请求没发出去就一次都不转（变量名缺席、密钥为空都在 setBusy 之前
   * return 了）。
   *
   * 计时器只负责补一句话，不负责停动画。busy 落下时把它一并复位，否则下一次写入会带着
   * 上一次的「还在等」开场。
   */
  useEffect(() => {
    if (!busy) {
      setWaited(false)
      return
    }

    const timer = setTimeout(() => {
      setWaited(true)
    }, SLOW_WRITE_MS)

    return () => {
      clearTimeout(timer)
    }
  }, [busy])

  /*
   * 写入这一半。
   *
   * probe 是它的入参而不是它的后续：调用它的时候结论已经有了，这里只是把结论跟着
   * 一起说出来。此前反过来 —— 先写再验 —— 那个顺序下，一把厂商当场就否掉的密钥
   * 照样落进了 config.toml，界面只是事后补一句「不过它是错的」，下次启动它还会
   * 拿着这把钥匙去连。验证放在写入之后，等于验了也白验。
   */
  const write = useCallback(
    (keyVar: string, secret: string, probe: ProviderKeyProbe, catalog: AgentCatalogCodec) => {
      /*
       * 只在配置里还没有 default_model 时，才随这次 catalog add 一起把它写掉。
       *
       * 为什么必须写：上游 hasUsableConfiguredDefaultModel 第一行是 defaultModel 缺席
       * 即 return false（packages/agent-contract-adapter/src/server.ts）。顶层没有这一行，配置里
       * 的 api_key 整条不算数，session/new 一律 authRequired。
       *
       * 为什么不无条件写：--default-model 是覆盖。已经配过一家、默认模型也选好了的人，
       * 再给第二家填个密钥，默认模型会被无声换掉。读不到就当它已经有了：宁可这一次
       * 不带，也不要盖掉人自己选好的那个。
       */
      void store
        .loadDefaultModel(agentId)
        .catch(() => '')
        .then((existing) => {
          const seed = existing === null ? catalog.presetDefaultModelId(provider) : undefined

          let args: readonly string[]

          /*
           * 条件展开而不是传 undefined：exactOptionalPropertyTypes 下，可选属性收不了一个
           * 显式的 undefined。
           */
          try {
            args = catalog.catalogAddArgs({
              providerId: provider.id,
              ...(seed === undefined ? {} : { defaultModelId: seed }),
              ...(provider.baseUrl === '' ? {} : { baseUrl: provider.baseUrl }),
            })
          } catch (cause: unknown) {
            setBusy(false)
            setMessage(describeAgentCliFailure(cause, '这组参数没法安全地交给命令行。'))
            return
          }

          return store
            .execCli({
              agentId,
              args,
              secretVar: keyVar,
              secretValue: secret,
              catalogDocument: catalog.catalogDocument([provider]),
            })
            .then(
              (outcome) => {
                setBusy(false)

                if (outcome.status !== 0) {
                  setMessage(describeAgentCliOutcome(outcome))
                  return
                }

                setApiKey('')
                onSaved()
                setMessage(describeKeyVerdict(probe, provider.displayName))
              },
              (cause: unknown) => {
                setBusy(false)
                setMessage(describeAgentCliFailure(cause, '写入失败，请重试。'))
              },
            )
        })
    },
    [agentId, onSaved, provider, store],
  )

  /*
   * 提交这一半：先问厂商认不认，再决定要不要写。
   *
   * 只有 401 拦得住写入。这不是措辞谨慎，是判据本身 —— 401 之外没有任何一种结论能
   * 排除「密钥其实是对的」：404 说的是这家没有可校验的端点，连不上说的是网络或代理，
   * 403 说的是权限不是身份。拿这些去拒绝一个人配置软件，是让用户替我们的无知买单。
   *
   * 探测这条路自己抛了，同样按连不上处理：验证机制坏掉不能连累写入。
   */
  const submit = useCallback(() => {
    if (registryKeyVar === undefined) {
      setMessage('这个 agent 没有声明该往哪个环境变量注入密钥，无法从这里写入。')
      return
    }

    const secret = apiKey.trim()

    if (secret.length === 0) {
      return
    }

    /*
     * 早退之后 registryKeyVar 已经不是 undefined 了，但那次收窄未必跟得进下面的
     * 闭包。落成一个本地 const，不指望编译器替我们记住。
     */
    const keyVar: string = registryKeyVar

    /*
     * 目录该写成什么形状，由这一家的编解码器说 —— 那是它的 CLI 的契约，不是通用事实。
     *
     * 缺席不是错误，是"这一家不从这里写目录"。处置与上面缺变量名那条完全同构：说出来，
     * 不假装写了。收成本地 const 之后交给 write，不指望编译器把收窄带进闭包。
     */
    const catalog = agentCatalogCodec(agentId)

    if (catalog === undefined) {
      setMessage('这个 agent 没有声明该怎么写入 provider 目录，无法从这里写入。')
      return
    }

    setBusy(true)

    void store
      .verifyProviderKey({ baseUrl: provider.baseUrl, secret })
      .catch((): ProviderKeyProbe => ({ verdict: 'unreachable', status: 0, modelIds: [] }))
      .then((probe) => {
        if (probe.verdict === 'rejected') {
          setBusy(false)
          setMessage(describeKeyVerdict(probe, provider.displayName))
          return
        }

        setMessage(null)
        write(keyVar, secret, probe, catalog)
      })
  }, [agentId, apiKey, provider, registryKeyVar, store, write])

  return (
    <div aria-busy={busy} className="models-card">
      <div className="models-row">
        <div className="models-row__copy">
          <strong>{provider.displayName}</strong>
          <p>{provider.description}</p>
        </div>
      </div>

      <SubField
        label="API 密钥"
        onChange={editKey}
        placeholder={`输入 ${provider.displayName} API 密钥`}
        secret
        value={apiKey}
      />

      <div className="models-row models-row--field">
        <span className="models-row__name">密钥申请地址</span>

        <div className="models-row__control">
          <span className="models-row__meta">{provider.apiKeysUrl}</span>
        </div>
      </div>

      {/*
       * 接口地址与上一行同构：名字在左、值在右。此前它把值拼进标签里，而
       * baseUrl 可以是空 —— submit 里那句 provider.baseUrl === '' 就是证据 ——
       * 于是那种厂商这里显示的是「接口地址 」加一段空白。空就不画这一行。
       */}
      {provider.baseUrl === '' ? null : (
        <div className="models-row models-row--field">
          <span className="models-row__name">接口地址</span>

          <div className="models-row__control">
            <span className="models-row__meta">{provider.baseUrl}</span>
          </div>
        </div>
      )}

      <div className="models-row models-row--field">
        {/*
         * 回执与动作同一行：左边说发生了什么，右边是引发它的那个动作。
         *
         * 此前这两句话是卡片中段两段 .models-empty —— 一个叫「空状态」的类被拿
         * 来说「已写入」和错误原因，而且回执与按钮隔着三行。
         *
         * 这个区域常驻，不再随内容出现才挂载：live region 要先在场、再变内容，
         * 否则读屏不会播报 —— 按下保存之后什么也听不到，正是此前的行为。
         */}
        <span aria-live="polite" className="models-row__meta">
          {busy && waited ? '还在等 agent 回应，正在等它写完配置。' : message}
        </span>

        <div className="models-row__control">
          {busy ? <InlineSpinner /> : null}

          <Button
            disabled={busy || apiKey.trim().length === 0}
            onClick={submit}
            size="xs"
            type="button"
            variant="soft"
          >
            {busy ? '正在写入…' : '保存到 agent'}
          </Button>
        </div>
      </div>
    </div>
  )
}
