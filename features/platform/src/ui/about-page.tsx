import { Button, SettingRow, SettingsGroup, SettingsPage } from '@poietica/design-system'
import {
  builtinPoints,
  FeatureScope,
  ToastsToken,
  useContributions,
  useCoreStatus,
  useService,
} from '@poietica/ui-kernel'
import { type ReactElement, useEffect, useState } from 'react'
import type { AppInfo, CoreDiagnostics } from '../contract'
import type { PlatformApi } from './api'

/*
 * 关于页。**迁移自** legacy `settings-surface.tsx` 的 AboutSettings：
 * 版本卡、四条架构原则、软件目录明细表都照旧；「诊断与更新」那组由 update 功能贡献
 * （`builtinPoints.settingsSections` 的 `page: 'platform.about'`，见 update 的
 * `UpdateAboutGroup`）—— 产品负责人 2026-10-06：软件更新并入关于页，不再单占导航一格。
 * 这一层只出页面骨架，不 import update 的 ui（守则 3）。
 */

const PRINCIPLES = [
  { index: '01', title: 'Agent 集成', description: '统一各类 Agent 交互规范' },
  { index: '02', title: '本地优先', description: '文档和设置优先安全保存在当前设备' },
  { index: '03', title: '安全可靠', description: '原子文件写入、明确边界和可恢复流程' },
  { index: '04', title: '高性能', description: '界面保持轻量，长任务不阻塞主线程' },
] as const

function Principle({
  index,
  title,
  description,
}: {
  readonly index: string
  readonly title: string
  readonly description: string
}): ReactElement {
  return (
    <article className="settings-principle">
      <span>{index}</span>
      <strong>{title}</strong>
      <p>{description}</p>
    </article>
  )
}

/**
 * Core 状态的说法。**迁移自** legacy 里原先散在状态栏/横幅的那几句话，落成一格设置项。
 * 五个 state 都出中文（与 CoreStatus 的枚举一一对应）。
 */
const CORE_STATE_TEXT: Readonly<Record<string, string>> = {
  starting: '正在启动',
  ready: '已就绪',
  restarting: '正在重新连接',
  failed: '引擎不可用',
  stopped: '已停止',
}

/**
 * 落在关于页里的**别的功能**贡献的那些组（builtinPoints.settingsSections）。
 *
 * 目前只有 update 的「软件更新」一组。`page` 是字符串，所以平台包不认识任何功能
 * （守则 3）；每一段用 FeatureScope 包住，贡献者的组件仍然按它自己的功能 id 取服务。
 */
function AboutSections(): ReactElement | null {
  const sections = useContributions(builtinPoints.settingsSections).filter((c) => c.item.page === 'platform.about')

  if (sections.length === 0) return null

  return (
    <>
      {sections.map(({ featureId, item }) => {
        const Component = item.component

        return (
          <FeatureScope featureId={featureId} key={item.id}>
            <Component />
          </FeatureScope>
        )
      })}
    </>
  )
}

/** 关于页：版本、Core 状态与软件目录（迁移自 legacy 的版本卡 + 明细表） */
export function AboutPage({ api }: { readonly api: PlatformApi }): ReactElement {
  const toasts = useService(ToastsToken)
  const coreStatus = useCoreStatus()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [diag, setDiag] = useState<CoreDiagnostics | null>(null)

  useEffect(() => {
    let cancelled = false
    void api
      .appInfo()
      .then((v) => {
        if (!cancelled) setInfo(v)
      })
      .catch(() => undefined)
    void api
      .diagnostics()
      .then((v) => {
        if (!cancelled) setDiag(v)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [api])

  const copyDiagnostics = async (): Promise<void> => {
    const text = JSON.stringify({ app: info, core: diag }, null, 2)
    try {
      await navigator.clipboard.writeText(text)
    } catch (e) {
      toasts.error(e, '复制失败')
    }
  }

  return (
    <SettingsPage>
      <div className="settings-about-card">
        <div className="settings-about-card__copy">
          <strong>Poietica</strong>
          <span data-about-version>Version {info?.version ?? '…'}</span>
          <p>使用 React、Electron 与 {info?.isPackaged ? '打包版' : '开发版'} 构建。</p>
        </div>
      </div>

      <div className="settings-principles">
        {PRINCIPLES.map((x) => (
          <Principle description={x.description} index={x.index} key={x.index} title={x.title} />
        ))}
      </div>

      <dl className="settings-about-details">
        <div>
          <dt>桌面运行时</dt>
          <dd>Electron</dd>
        </div>

        <div>
          <dt>设置存储</dt>
          <dd>JSON（应用设置）</dd>
        </div>

        <div>
          <dt>软件目录</dt>
          <dd data-about-dataroot>{info?.dataRoot ?? '…'}</dd>
        </div>

        {/* Core（Agent 引擎）此刻的状态。原先是状态栏左端那一格，本设计没有状态栏，
            于是它落到这里 —— 与版本号、软件目录同属「这台软件此刻怎么样」。 */}
        <div>
          <dt>Agent 引擎</dt>
          <dd data-about-core-status={coreStatus.state}>
            {CORE_STATE_TEXT[coreStatus.state] ?? coreStatus.state}
            {coreStatus.state === 'restarting' ? `（第 ${coreStatus.attempt} 次）` : null}
          </dd>
        </div>
      </dl>

      {/* legacy 的「诊断与更新」组就在明细表之后；update 功能把那一组贡献到这里。 */}
      <AboutSections />

      <SettingsGroup title="诊断">
        <SettingRow description="把版本与引擎目录复制到剪贴板，便于排查" label="复制诊断信息">
          <Button onClick={() => void copyDiagnostics()} size="xs" type="button" variant="soft">
            复制
          </Button>
        </SettingRow>
        <SettingRow description="打开应用的数据根目录" label="打开数据文件夹">
          <Button onClick={() => void api.openDataFolder()} size="xs" type="button" variant="soft">
            打开
          </Button>
        </SettingRow>
      </SettingsGroup>
    </SettingsPage>
  )
}
