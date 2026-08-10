import type { ThreadsStore } from '@poietica/agent'
import {
  Button,
  ErrorState,
  LoadingState,
  Select,
  type SelectOption,
  Switch,
  WebhookIcon,
} from '@poietica/ui'
import { Archive, Box, Settings as CogFour } from 'lucide-react'
import {
  type ComponentType,
  createContext,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { AgentConfigStore } from '../agent-config-store'
import { ModelsSettings } from '../models/models-settings'
import type { AppSettings } from '../settings'
import type { SettingsStore } from '../settings-store'
import { ArchivedChatsSettings } from './archived-chats-settings'
import {
  type SettingsController,
  type SettingsOperation,
  useSettingsController,
} from './use-settings-controller'
import './settings-surface.css'

type SettingsSection =
  | 'general'
  | 'appearance'
  | 'archived'
  | 'models'
  | 'keymap'
  | 'hooks'
  | 'tools'
  | 'privacy'
  | 'about'

/*
 * 导航只列产品当前真的有的东西。
 *
 * 导出那一组的三个控件（SVG / PNG DPI / PDF 质量）随旧产品形态一起退场；
 * 「插件」这个词从来没有对应实现，换成 Tool——内置工具、Skill 与 MCP
 * 服务器是这个产品真正的扩展面。
 *
 * privacy 里的每一项都写进 AppSettings 并落盘。models / keymap / hooks /
 * tools 在 AppSettings 里还没有任何字段，所以它们渲染明确的空状态，而不是
 * 拨得动却存不下的假开关。
 *
 * 分类到标签是一张按分类穷尽的表，不是一个待搜索的数组：全文没有一处遍历它，
 * 两个调用点都是拿 id 去搜，再对搜不到的情况判空、抛错。而 id 的类型就是这八个
 * 字面量的联合 —— 那个分支在类型上不可能走到，它把编译期已经证明的事挪到运行时
 * 又验了一遍，代价是每次渲染一次线性扫描，和一条永远读不到的错误文案。
 *
 * 写成 Record 之后查找是索引，缺键在 typecheck 阶段就是错误。下面的
 * SECTION_GLYPHS 与 SECTION_PATHS 本来就是这个形状，这里跟它们对齐。
 */
const SECTIONS: Record<SettingsSection, string> = {
  general: '通用',
  appearance: '外观',
  archived: '已归档',
  models: '模型',
  keymap: '快捷键',
  hooks: '钩子',
  tools: 'plugin',
  privacy: '隐私',
  about: '关于',
}

/**
 * 导航分组。图二用间距而不是标题分隔分组，所以这里只描述分组关系，
 * 标签仍然来自 SECTIONS，避免同一份文案出现两处。
 */
const SECTION_GROUPS: readonly (readonly SettingsSection[])[] = [
  ['general', 'appearance', 'archived'],
  ['models', 'keymap', 'hooks', 'tools'],
  ['privacy', 'about'],
]

/*
 * 设置导航与设置内容是外壳栅格里两个互不嵌套的格子（第 1 列与第 2 列）。
 *
 * 它们没有父子关系，所以控制器与当前分类只能由共同祖先持有。这就是这个
 * context 存在的唯一理由：不是为了解耦，而是因为 DOM 上没有别的地方可放。
 * 侧边栏的宽度、拖拽与开合仍然只有 workspaceLayoutStore 一个来源。
 */
interface SettingsSurfaceContextValue {
  readonly controller: SettingsController
  readonly agentConfigStore: AgentConfigStore
  readonly threads: ThreadsStore
  readonly appVersion: () => Promise<string>
  readonly dataDirectory: () => Promise<string>
  readonly section: SettingsSection
  readonly onSelect: (section: SettingsSection) => void
  readonly onBack: () => void
}

const SettingsSurfaceContext = createContext<SettingsSurfaceContextValue | null>(null)

function useSettingsSurface(): SettingsSurfaceContextValue {
  const value = useContext(SettingsSurfaceContext)

  if (!value) {
    throw new Error('设置区域必须渲染在 SettingsProvider 内部。')
  }

  return value
}

export interface SettingsProviderProps {
  readonly store: SettingsStore
  readonly agentConfigStore: AgentConfigStore
  readonly threads: ThreadsStore
  /**
   * 这台机器上，这个应用的数据落在哪，由组合根注入。
   *
   * 与 appVersion 同一条理由：这个包不认识桌面传输层，它的依赖里没有
   * @tauri-apps/api，也不该有。
   */
  readonly dataDirectory: () => Promise<string>
  /**
   * 这个可执行文件自己的版本号，由组合根注入。
   *
   * 不在这里直接问 Tauri：功能层认识桌面传输层，就是 ports/settings-store.ts
   * 那段注释记着的老账。这个包的依赖里也确实没有 @tauri-apps/api。
   */
  readonly appVersion: () => Promise<string>
  /** 离开设置。控制器会先把尚未落盘的草稿刷完再回调，所以退出不会丢改动。 */
  readonly onDismiss: () => void
  readonly children: ReactNode
}

export function SettingsProvider({
  store,
  agentConfigStore,
  threads,
  appVersion,
  dataDirectory,
  onDismiss,
  children,
}: SettingsProviderProps) {
  const [section, setSection] = useState<SettingsSection>('general')

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        onDismiss()
      }
    },
    [onDismiss],
  )

  // open 恒为 true：Provider 只在设置打开时挂载，开合由外壳决定。
  const controller = useSettingsController({
    open: true,
    store,
    onOpenChange: handleOpenChange,
  })

  const value = useMemo<SettingsSurfaceContextValue>(
    () => ({
      controller,
      agentConfigStore,
      threads,
      appVersion,
      dataDirectory,
      section,
      onSelect: setSection,
      onBack: controller.requestClose,
    }),
    [agentConfigStore, appVersion, controller, dataDirectory, section, threads],
  )

  return <SettingsSurfaceContext value={value}>{children}</SettingsSurfaceContext>
}

export interface SettingsNavigationRegionProps {
  /** 侧边栏底部行，由应用组合根注入，齿轮在设置里保持高亮。 */
  readonly footer?: ReactNode
}

export function SettingsNavigationRegion({ footer }: SettingsNavigationRegionProps) {
  const { section, onSelect, onBack } = useSettingsSurface()

  return (
    <SettingsNavigation
      activeSection={section}
      footer={footer}
      onBack={onBack}
      onSelect={onSelect}
    />
  )
}

export function SettingsContentRegion() {
  const { controller, agentConfigStore, appVersion, dataDirectory, section, threads } =
    useSettingsSurface()

  return (
    <div aria-live="polite" className="settings-content">
      <div className="settings-content__inner">
        <h2 className="settings-content__title">{SECTIONS[section]}</h2>

        {controller.loading ? (
          <div className="settings-state">
            <LoadingState label="正在读取本地设置…" />
          </div>
        ) : null}

        {!controller.loading && controller.error && !controller.settings ? (
          <div className="settings-state">
            <ErrorState message={controller.error} onRetry={controller.retry} />
          </div>
        ) : null}

        {controller.settings ? (
          <>
            {controller.error ? (
              <SettingsErrorBanner
                message={controller.error}
                onRetry={controller.retry}
                operation={controller.operation}
              />
            ) : null}

            <SettingsSectionContent
              agentConfigStore={agentConfigStore}
              appVersion={appVersion}
              controller={controller}
              dataDirectory={dataDirectory}
              section={section}
              settings={controller.settings}
              threads={threads}
            />
          </>
        ) : null}
      </div>
    </div>
  )
}

interface SettingsNavigationProps {
  readonly activeSection: SettingsSection
  readonly onSelect: (section: SettingsSection) => void
  readonly onBack: () => void
  readonly footer?: ReactNode
}

const SettingsNavigation = memo(function SettingsNavigation({
  activeSection,
  onSelect,
  onBack,
  footer,
}: SettingsNavigationProps) {
  return (
    <section aria-label="设置分类" className="settings-navigation">
      <button className="settings-navigation__back" onClick={onBack} type="button">
        <svg
          aria-hidden="true"
          className="settings-navigation__icon"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.7"
          viewBox="0 0 24 24"
        >
          <path d="M19 12H5" />
          <path d="m11 6-6 6 6 6" />
        </svg>

        <span>返回</span>
      </button>

      <div className="settings-navigation__scroll">
        {SECTION_GROUPS.map((group) => (
          <nav className="settings-navigation__items" key={group.join('-')}>
            {group.map((id) => {
              const active = id === activeSection

              return (
                <button
                  aria-current={active ? 'page' : undefined}
                  className="settings-navigation__item"
                  data-active={active ? 'true' : 'false'}
                  key={id}
                  onClick={() => {
                    onSelect(id)
                  }}
                  type="button"
                >
                  <SectionIcon section={id} />

                  <span>{SECTIONS[id]}</span>
                </button>
              )
            })}
          </nav>
        ))}
      </div>

      {footer ? <div className="settings-navigation__footer">{footer}</div> : null}
    </section>
  )
})

interface SettingsSectionContentProps {
  readonly section: SettingsSection
  readonly settings: AppSettings
  readonly controller: SettingsController
  readonly agentConfigStore: AgentConfigStore
  readonly threads: ThreadsStore
  readonly appVersion: () => Promise<string>
  readonly dataDirectory: () => Promise<string>
}

function SettingsSectionContent({
  section,
  settings,
  controller,
  agentConfigStore,
  threads,
  appVersion,
  dataDirectory,
}: SettingsSectionContentProps) {
  switch (section) {
    case 'general':
      return <GeneralSettings controller={controller} />

    case 'appearance':
      return <AppearanceSettings controller={controller} settings={settings} />

    case 'archived':
      return <ArchivedChatsSettings threads={threads} />

    case 'models':
      return <ModelsSettings store={agentConfigStore} />

    case 'keymap':
      return (
        <SettingsPlaceholder description="快捷键还不可改写。当前生效的绑定可在命令面板（Mod+K）中查看。" />
      )

    case 'hooks':
      return <SettingsPlaceholder description="Hook 尚未实现。" />

    case 'tools':
      return <SettingsPlaceholder description="内置工具、Skill 与 MCP 服务器的管理尚未实现。" />

    case 'privacy':
      return <PrivacySettings controller={controller} settings={settings} />

    case 'about':
      return <AboutSettings readDataDirectory={dataDirectory} readVersion={appVersion} />
  }
}

interface SettingsPanelProps {
  readonly settings: AppSettings
  readonly controller: SettingsController
}

const GeneralSettings = memo(function GeneralSettings({
  controller,
}: Pick<SettingsPanelProps, 'controller'>) {
  return (
    <SettingsPage>
      <SettingsGroup title="重置">
        <SettingRow description="把全部设置项还原为初始值" label="恢复默认设置">
          <Button
            disabled={controller.saving}
            onClick={controller.reset}
            size="xs"
            type="button"
            variant="soft"
          >
            {controller.saving && controller.operation === 'reset' ? '正在恢复…' : '恢复默认'}
          </Button>
        </SettingRow>
      </SettingsGroup>
    </SettingsPage>
  )
})

const PrivacySettings = memo(function PrivacySettings({
  settings,
  controller,
}: SettingsPanelProps) {
  return (
    <SettingsPage>
      <SettingsGroup title="诊断与更新">
        <ToggleRow
          checked={settings.privacy.telemetry}
          description="上报不含文档内容的功能使用统计"
          label="匿名使用数据"
          onChange={(checked) => {
            controller.update((current) => ({
              ...current,
              privacy: {
                ...current.privacy,
                telemetry: checked,
              },
            }))
          }}
        />

        <ToggleRow
          checked={settings.privacy.crashReporting}
          description="崩溃时上报堆栈以便定位问题"
          label="崩溃报告"
          onChange={(checked) => {
            controller.update((current) => ({
              ...current,
              privacy: {
                ...current.privacy,
                crashReporting: checked,
              },
            }))
          }}
        />

        <ToggleRow
          checked={settings.privacy.updateCheck}
          description="启动时向更新服务查询新版本"
          label="自动检查更新"
          onChange={(checked) => {
            controller.update((current) => ({
              ...current,
              privacy: {
                ...current.privacy,
                updateCheck: checked,
              },
            }))
          }}
        />
      </SettingsGroup>
    </SettingsPage>
  )
})

interface AboutSettingsProps {
  readonly readDataDirectory: () => Promise<string>
  readonly readVersion: () => Promise<string>
}

const AboutSettings = memo(function AboutSettings({
  readDataDirectory,
  readVersion,
}: AboutSettingsProps) {
  const [version, setVersion] = useState<string>()
  const [directory, setDirectory] = useState<string>()

  /*
   * 版本号问的是这个可执行文件自己。
   *
   * 此前这里是写死的 "Version 0.1.0" —— 版本号的第四个真相来源，而
   * scripts/release/check-versions.mjs 只对齐 package.json、Cargo.toml 与
   * tauri.conf.json 那三个，扫不到一段 JSX 里的字符串。发到 0.1.1 之后这里会
   * 一直说 0.1.0，而更新器比对的是另一个数：用户看到的版本，和软件认为自己是
   * 的版本，从此不是同一个东西。
   *
   * 读不出来就不写出一个数。一个说错了的版本号比一个没说出来的有害得多 ——
   * 这正是这段代码在修的那个 bug 的教训。
   */
  useEffect(() => {
    let active = true

    void readVersion().then(
      (value) => {
        if (active) {
          setVersion(value)
        }
      },
      () => undefined,
    )

    return () => {
      active = false
    }
  }, [readVersion])

  /*
   * 路径问的是原生侧，与版本号同一条纪律。
   *
   * 渲染层没有第二种算法：安装期可以把数据目录指到任何地方，「%LOCALAPPDATA%
   * 加产品名」这个假设在那一刻就不成立了。读不出来就不写出一条路径 —— 一条
   * 说错了的路径会把用户的备份引到一个空目录。
   */
  useEffect(() => {
    let active = true

    void readDataDirectory().then(
      (value) => {
        if (active) {
          setDirectory(value)
        }
      },
      () => undefined,
    )

    return () => {
      active = false
    }
  }, [readDataDirectory])

  return (
    <SettingsPage>
      <div className="settings-about-card">
        <div className="settings-about-card__copy">
          <strong>Poietica</strong>
          <span>Version {version ?? '…'}</span>
          <p>使用 React、Tauri 与 Rust 构建。</p>
        </div>
      </div>

      <div className="settings-principles">
        <ArchitecturePrinciple description="统一各类Agent交互规范" index="01" title="ACP集成" />

        <ArchitecturePrinciple
          description="文档和设置优先安全保存在当前设备"
          index="02"
          title="本地优先"
        />

        <ArchitecturePrinciple
          description="原子文件写入、明确边界和可恢复流程"
          index="03"
          title="安全可靠"
        />

        <ArchitecturePrinciple
          description="界面保持轻量，长任务不阻塞主线程"
          index="04"
          title="高性能"
        />
      </div>

      <dl className="settings-about-details">
        <div>
          <dt>桌面运行时</dt>
          <dd>Tauri</dd>
        </div>

        <div>
          <dt>设置存储</dt>
          <dd>Tauri Store</dd>
        </div>

        <div>
          <dt>软件目录</dt>
          <dd className="settings-about-path">{directory ?? '…'}</dd>
        </div>
      </dl>
    </SettingsPage>
  )
})

interface SettingsPageProps {
  readonly children: ReactNode
}

function SettingsPage({ children }: SettingsPageProps) {
  return (
    <section className="settings-page">
      <div className="settings-page__body">{children}</div>
    </section>
  )
}

interface SettingsGroupProps {
  readonly title: string
  readonly children: ReactNode
}

function SettingsGroup({ title, children }: SettingsGroupProps) {
  return (
    <section className="settings-group">
      <header className="settings-group__header">
        <h3>{title}</h3>
      </header>

      <div className="settings-group__surface">{children}</div>
    </section>
  )
}

interface SettingRowProps {
  readonly label: string
  readonly description?: string
  readonly children: ReactNode
}

function SettingRow({ label, description, children }: SettingRowProps) {
  return (
    <div className="settings-row">
      <div className="settings-row__copy">
        <strong>{label}</strong>
        {description ? <p>{description}</p> : null}
      </div>

      <div className="settings-row__control">{children}</div>
    </div>
  )
}

interface ToggleRowProps {
  readonly checked: boolean
  readonly label: string
  readonly description?: string
  readonly onChange: (checked: boolean) => void
}

function ToggleRow({ checked, label, description, onChange }: ToggleRowProps) {
  return (
    <div className="settings-row">
      <div className="settings-row__copy">
        <strong>{label}</strong>
        {description ? <p>{description}</p> : null}
      </div>

      <div className="settings-row__control">
        <Switch aria-label={label} checked={checked} onCheckedChange={onChange} size="sm" />
      </div>
    </div>
  )
}

interface SettingsErrorBannerProps {
  readonly operation: SettingsOperation | undefined
  readonly message: string
  readonly onRetry: () => void
}

function SettingsErrorBanner({ operation, message, onRetry }: SettingsErrorBannerProps) {
  const operationLabel =
    operation === 'reset' ? '重置设置失败' : operation === 'save' ? '保存设置失败' : '读取设置失败'

  return (
    <div className="settings-error" role="alert">
      <div>
        <strong>{operationLabel}</strong>
        <p>{message}</p>
      </div>

      <Button onClick={onRetry} size="sm" type="button" variant="outline">
        重试
      </Button>
    </div>
  )
}

interface ArchitecturePrincipleProps {
  readonly index: string
  readonly title: string
  readonly description: string
}

function ArchitecturePrinciple({ index, title, description }: ArchitecturePrincipleProps) {
  return (
    <article className="settings-principle">
      <span>{index}</span>
      <strong>{title}</strong>
      <p>{description}</p>
    </article>
  )
}

type GlyphComponent = ComponentType<{
  readonly className?: string
  readonly 'aria-hidden'?: 'true'
}>

/*
 * 分类图标有两个来源，各自穷尽自己的分类集合。
 *
 * GlyphSection 里的分类直接用主侧边栏的字形组件：Hook 在主导航里已经有确定的
 * 画法，设置里再描一份 path 就是第二个来源，两处迟早对不上。
 *
 * 「通用」曾经就是这句话的反例。侧边栏底部那颗齿轮是 CogFour，而这里另手描了
 * 一份齿轮 path —— 同一个「设置」在同一个产品里有两个画法，粗细、齿数、内圆
 * 半径都对不上，而且没有任何机制会在它们分叉时报错。现在它也从库里取同一枚。
 *
 * 图标不从 packages/workspace 的导航注册表取：features-settings 依赖另一个
 * feature 会被架构测试拦下。两边共同的下游是 design-system，所以两处引用的是
 * 同一个组件，而不是同一张图的两份摹本。
 *
 * 拆成两张 Record 而不是在组件里写 if：新增分类时 PathSection 一侧会缺键，
 * typecheck 阶段就会失败，而不是运行时渲染出一个空图标。
 */
type GlyphSection = 'general' | 'archived' | 'hooks' | 'tools'

type PathSection = Exclude<SettingsSection, GlyphSection>

const SECTION_GLYPHS: Record<GlyphSection, GlyphComponent> = {
  general: CogFour,
  archived: Archive,
  hooks: WebhookIcon,
  tools: Box,
}

/*
 * 描边路径与上面那张字形表同级、同纪律。
 *
 * 它此前造在 SectionIcon 的函数体里：五棵 JSX 子树每次渲染全部新建，用掉一棵、
 * 扔掉四棵，侧边栏八个按钮每重画一次就是四十棵。而这个文件对静态表本来就有
 * 定论 —— COLOR_MODES / LANGUAGES 那段注释说的就是这件事。
 */
const SECTION_PATHS: Record<PathSection, ReactNode> = {
  appearance: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
    </>
  ),
  models: (
    <>
      <rect height="12" rx="2" width="12" x="6" y="6" />
      <path d="M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3" />
    </>
  ),
  keymap: (
    <>
      <rect height="12" rx="2" width="18" x="3" y="6" />
      <path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8" />
    </>
  ),
  privacy: (
    <>
      <path d="M12 3 5 6v5c0 4.4 2.9 8.4 7 10 4.1-1.6 7-5.6 7-10V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  about: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
}

function isGlyphSection(section: SettingsSection): section is GlyphSection {
  return (
    section === 'general' || section === 'archived' || section === 'hooks' || section === 'tools'
  )
}

function SectionIcon({ section }: { readonly section: SettingsSection }) {
  if (isGlyphSection(section)) {
    const Glyph = SECTION_GLYPHS[section]

    return <Glyph aria-hidden="true" className="settings-navigation__icon" />
  }

  return (
    <svg
      aria-hidden="true"
      className="settings-navigation__icon"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
    >
      {SECTION_PATHS[section]}
    </svg>
  )
}

/*
 * 两张静态表，和 SECTIONS / SECTION_GROUPS 一样属于模块。
 *
 * 上一版它们已经不再是 JSX 里的行内字面量，但形状还是 [value, label] 元组 —— 于是
 * 每次渲染仍要 map 成基元认的 { value, label }，末端还欠一次 as 断言把闭合联合接
 * 回去。形状直接写成基元认的那一种，两样一起没有了：类型参数保住「只可能是这几个
 * 字面量」，onValueChange 的入参因此就是 AppSettings 上那个字段本身。
 */
const COLOR_MODES: readonly SelectOption<AppSettings['theme']>[] = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]

const LANGUAGES: readonly SelectOption<AppSettings['language']>[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
]

const AppearanceSettings = memo(function AppearanceSettings({
  settings,
  controller,
}: SettingsPanelProps) {
  return (
    <SettingsPage>
      <SettingsGroup title="主题与语言">
        <SettingRow description="浅色、深色或跟随系统" label="颜色模式">
          <Select
            align="end"
            className="settings-select-trigger"
            data={COLOR_MODES}
            onValueChange={(theme) => {
              controller.update((current) => ({
                ...current,
                theme,
              }))
            }}
            type="颜色模式"
            value={settings.theme}
          />
        </SettingRow>

        <SettingRow description="界面文案使用的语言" label="界面语言">
          <Select
            align="end"
            className="settings-select-trigger"
            data={LANGUAGES}
            onValueChange={(language) => {
              controller.update((current) => ({
                ...current,
                language,
              }))
            }}
            type="界面语言"
            value={settings.language}
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsPage>
  )
})

interface SettingsPlaceholderProps {
  readonly description: string
}

/*
 * 一个还没有数据的分组说自己没有数据。
 *
 * 这里刻意不放能拨动的控件：写不进 AppSettings 的开关会让人以为设置生效了，
 * 比一句实话有害得多。
 *
 * 也刻意没有标题。分类标题由 SettingsContentRegion 从 SECTIONS 渲染，这里再画
 * 一个只会让同一句文案出现两遍、并且多出第二个来源。
 */
function SettingsPlaceholder({ description }: SettingsPlaceholderProps) {
  return (
    <SettingsPage>
      <p className="settings-placeholder">{description}</p>
    </SettingsPage>
  )
}
