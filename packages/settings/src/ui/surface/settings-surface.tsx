import type { AgentSkill, ThreadsStore } from '@poietica/conversation'
import {
  Button,
  ErrorState,
  LoadingState,
  Select,
  type SelectOption,
} from '@poietica/design-system'
import type { PluginStore } from '@poietica/extension'
import type {
  AgentSettings,
  AppSettings,
  KeybindingCatalog,
  ModelCatalogStore,
  SettingsStore,
} from '@poietica/settings'
import {
  Archive,
  ArrowLeft,
  Settings as CogFour,
  Cpu,
  Info,
  Keyboard,
  Monitor,
  PackageOpen,
  ShieldCheck,
  Sun,
  Zap,
} from 'lucide-react'
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
  useSyncExternalStore,
} from 'react'
import { ComputerUseSettings } from '../computer-use-settings'
import { KeymapSettings } from '../keymap-settings'
import { ModelsSettings } from '../models/models-settings'
import { SkillsSettings } from '../skills-settings'
import type { ReadTokenDays } from '../usage-activity'
import { UsageSettings } from '../usage-settings'
import { ArchivedChatsSettings } from './archived-chats-settings'
import { MascotPrefsGroup } from './mascot-prefs'
import { SettingRow, SettingsGroup, SettingsPage, ToggleRow } from './settings-primitives'
import {
  type SettingsController,
  type SettingsOperation,
  useSettingsController,
} from './use-settings-controller'
import './settings-surface.css'

/* Settings sections ship with the first paint. */

type SettingsSection =
  | 'general'
  | 'appearance'
  | 'archived'
  | 'models'
  | 'skills'
  | 'keymap'
  | 'computer-use'
  | 'usage'
  | 'privacy'
  | 'about'

type GlyphComponent = ComponentType<{
  readonly className?: string
  readonly 'aria-hidden'?: 'true'
}>

/*
 * 一个分类只在这里定义一次：标签、图标、内容各是它的一列。
 *
 * 此前这三件事分在三张表加一个 switch 里，新增一页要改四处，而只有标签那一处
 * 缺键会被 typecheck 拦下；图标那两张表还要靠一个运行时类型守卫去分割分类集合，
 * 守卫本身也得跟着手改。写成一张 Record 之后，缺任何一列都是编译错误。
 *
 * 图标全部取自图标库。此前有五个分类是在这个文件里手描 path 的 —— "通用"那颗
 * 齿轮与侧边栏底部那颗是同一个"设置"，却有两个画法，粗细、齿数、内圆半径都对
 * 不上，而且没有任何机制会在它们分叉时报错。
 *
 * render 是闭包，求值发生在渲染时、晚于模块体，所以它引用下面声明的面板组件合法。
 */
interface SettingsSectionContext {
  readonly settings: AppSettings
  readonly controller: SettingsController
  readonly agentSettings: AgentSettings
  readonly modelCatalog: ModelCatalogStore
  readonly threads: ThreadsStore
  readonly keybindings: KeybindingCatalog
  readonly appVersion: () => Promise<string>
  readonly dataDirectory: () => Promise<string>
  /** Token 日账的读，由组合根注入：账本只有原生侧那一份。 */
  readonly readTokenDays: ReadTokenDays
  /** 技能名册，由组合根下传：名册属于会话上下文，住在更高的 assistant 环。 */
  readonly skills: readonly AgentSkill[]
  readonly plugins: PluginStore
}

interface SettingsSectionDescriptor {
  readonly label: string
  readonly icon: GlyphComponent
  readonly render: (context: SettingsSectionContext) => ReactNode
}

const SECTIONS: Record<SettingsSection, SettingsSectionDescriptor> = {
  general: {
    label: '通用',
    icon: CogFour,
    render: ({ controller, settings }) => (
      <GeneralSettings controller={controller} settings={settings} />
    ),
  },
  appearance: {
    label: '外观',
    icon: Sun,
    render: ({ controller, settings }) => (
      <AppearanceSettings controller={controller} settings={settings} />
    ),
  },
  archived: {
    label: '已归档',
    icon: Archive,
    render: ({ threads }) => <ArchivedChatsSettings threads={threads} />,
  },
  models: {
    label: '模型',
    icon: Cpu,
    render: ({ agentSettings, controller, modelCatalog, settings }) => (
      <ModelsSettings
        hiddenModelAliases={settings.modelPicker.hiddenModelAliases}
        modelCatalog={modelCatalog}
        onModelVisibilityChange={(modelId, visible) => {
          controller.update((current) => {
            const hidden = new Set(current.modelPicker.hiddenModelAliases)
            if (visible) {
              hidden.delete(modelId)
            } else {
              hidden.add(modelId)
            }
            return {
              ...current,
              modelPicker: {
                ...current.modelPicker,
                hiddenModelAliases: [...hidden].sort(),
              },
            }
          })
        }}
        onProviderOrderChange={(providerOrder) => {
          controller.update((current) => ({
            ...current,
            modelPicker: { ...current.modelPicker, providerOrder: [...providerOrder] },
          }))
        }}
        providerOrder={settings.modelPicker.providerOrder}
        store={agentSettings}
      />
    ),
  },
  skills: {
    label: '技能',
    icon: PackageOpen,
    render: ({ plugins, skills }) => <SkillsSettings skills={skills} store={plugins} />,
  },
  keymap: {
    label: '快捷键',
    icon: Keyboard,
    render: ({ keybindings }) => <KeymapSettings catalog={keybindings} />,
  },
  'computer-use': {
    label: '电脑控制',
    icon: Monitor,
    render: ({ plugins }) => <ComputerUseSettings store={plugins} />,
  },
  usage: {
    label: '用量',
    icon: Zap,
    render: ({ readTokenDays, threads }) => (
      <UsageSettings readTokenDays={readTokenDays} threads={threads} />
    ),
  },
  privacy: {
    label: '隐私',
    icon: ShieldCheck,
    render: ({ controller, settings }) => (
      <PrivacySettings controller={controller} settings={settings} />
    ),
  },
  about: {
    label: '关于',
    icon: Info,
    render: ({ appVersion, dataDirectory }) => (
      <AboutSettings readDataDirectory={dataDirectory} readVersion={appVersion} />
    ),
  },
}

/**
 * 导航分组。用间距而不是标题分隔分组，所以这里只描述分组关系，
 * 标签仍然来自 SECTIONS，避免同一份文案出现两处。
 */
const SECTION_GROUPS: readonly (readonly SettingsSection[])[] = [
  ['general', 'appearance'],
  ['models', 'skills', 'keymap', 'computer-use', 'usage', 'archived'],
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
  readonly agentSettings: AgentSettings
  readonly modelCatalog: ModelCatalogStore
  readonly threads: ThreadsStore
  readonly keybindings: KeybindingCatalog
  readonly appVersion: () => Promise<string>
  readonly dataDirectory: () => Promise<string>
  readonly readTokenDays: ReadTokenDays
  readonly skills: readonly AgentSkill[]
  readonly plugins: PluginStore
  readonly section: SettingsSection
  readonly onSelect: (section: SettingsSection) => void
  readonly onBack: () => void
}

const SettingsSurfaceContext = createContext<SettingsSurfaceContextValue | null>(null)
const HiddenModelAliasesContext = createContext<readonly string[] | null>(null)
const EMPTY_HIDDEN_MODEL_ALIASES: readonly string[] = Object.freeze([])

export function useHiddenModelAliases(): readonly string[] {
  const aliases = useContext(HiddenModelAliasesContext)
  if (aliases === null) {
    throw new Error('模型可见性必须渲染在 SettingsProvider 内部。')
  }
  return aliases
}

function useSettingsSurface(): SettingsSurfaceContextValue {
  const value = useContext(SettingsSurfaceContext)

  if (!value) {
    throw new Error('设置区域必须渲染在 SettingsProvider 内部。')
  }

  return value
}

export interface SettingsProviderProps {
  readonly store: SettingsStore
  readonly agentSettings: AgentSettings
  /** 模型目录的唯一持有者，由组合根注入：模型页读写经 kap REST 落在 agent 进程。 */
  readonly modelCatalog: ModelCatalogStore
  /** 插件账本的唯一持有者，由组合根注入：这个包不认识桌面传输层。 */
  readonly plugins: PluginStore
  /** KAP 按当前会话报告的技能名册。 */
  readonly threads: ThreadsStore
  /**
   * 当前生效的快捷键，由组合根注入。
   *
   * 真相在命令注册表里，而这个包不认识 packages/workspace —— 架构规则里
   * settings ✗→ workspace 是显式禁止的一条。与 appVersion 同一条理由。
   */
  readonly keybindings: KeybindingCatalog
  /**
   * 这台机器上，这个应用的数据落在哪，由组合根注入。
   *
   * 与 appVersion 同一条理由：这个包不认识桌面传输层，它的依赖里没有
   * @tauri-apps/api，也不该有。
   */
  readonly dataDirectory: () => Promise<string>
  /**
   * 最近若干天的 token 日账，由组合根注入。
   *
   * 与 appVersion 同一条理由：账本在原生侧，而这一层不该认识 native-bridge。
   */
  readonly readTokenDays: ReadTokenDays
  /**
   * 这个可执行文件自己的版本号，由组合根注入。
   *
   * 不在这里直接问 Tauri：功能层认识桌面传输层，就是 ports/settings-store.ts
   * 那段注释记着的老账。这个包的依赖里也确实没有 @tauri-apps/api。
   */
  readonly appVersion: () => Promise<string>
  /**
   * 这一家 agent 公布的技能名册，由组合根下传。
   *
   * 与 readTokenDays 同一条理由，再加一条环序：名册属于会话上下文，住在
   * assistant 环，本包在 vertical-feature 环，环序禁止反向依赖。
   */
  readonly skills: readonly AgentSkill[]
  /** 离开设置。控制器会先把尚未落盘的草稿刷完再回调，所以退出不会丢改动。 */
  readonly onDismiss: () => void
  /** 主题预览进入应用唯一的主题管线，不由设置 UI 直接写文档。 */
  readonly onThemeChange: (theme: AppSettings['theme']) => void
  /** 设置是否在场。会话只在打开时启动 —— 挂载不是开合信号。 */
  readonly isOpen: boolean
  readonly children: ReactNode
}

export function SettingsProvider({
  store,
  agentSettings,
  modelCatalog,
  plugins,
  threads,
  keybindings,
  appVersion,
  dataDirectory,
  readTokenDays,
  skills,
  onDismiss,
  onThemeChange,
  isOpen,
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

  const controller = useSettingsController({
    open: isOpen,
    store,
    onOpenChange: handleOpenChange,
    onThemeChange,
  })
  const persistedSettings = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  )
  const hiddenModelAliases =
    controller.settings?.modelPicker.hiddenModelAliases ??
    persistedSettings?.modelPicker.hiddenModelAliases ??
    EMPTY_HIDDEN_MODEL_ALIASES

  const value = useMemo<SettingsSurfaceContextValue>(
    () => ({
      controller,
      agentSettings,
      modelCatalog,
      plugins,
      threads,
      keybindings,
      appVersion,
      dataDirectory,
      readTokenDays,
      skills,
      section,
      onSelect: setSection,
      onBack: controller.requestClose,
    }),
    [
      agentSettings,
      appVersion,
      controller,
      dataDirectory,
      keybindings,
      modelCatalog,
      plugins,
      readTokenDays,
      section,
      skills,
      threads,
    ],
  )

  return (
    <HiddenModelAliasesContext value={hiddenModelAliases}>
      <SettingsSurfaceContext value={value}>{children}</SettingsSurfaceContext>
    </HiddenModelAliasesContext>
  )
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
  const {
    controller,
    agentSettings,
    appVersion,
    dataDirectory,
    keybindings,
    modelCatalog,
    plugins,
    readTokenDays,
    section,
    skills,
    threads,
  } = useSettingsSurface()

  return (
    <div aria-live="polite" className="settings-content">
      <div className="settings-content__inner" data-section={section}>
        <h2 className="settings-content__title">{SECTIONS[section].label}</h2>

        {controller.loading ? (
          <div className="settings-state">
            <LoadingState label="正在加载设置…" />
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

            {SECTIONS[section].render({
              agentSettings,
              appVersion,
              controller,
              dataDirectory,
              keybindings,
              modelCatalog,
              plugins,
              readTokenDays,
              settings: controller.settings,
              skills,
              threads,
            })}
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
        <ArrowLeft aria-hidden="true" className="settings-navigation__icon" strokeWidth={1.7} />

        <span>返回</span>
      </button>

      <div className="settings-navigation__scroll">
        {SECTION_GROUPS.map((group) => (
          <nav className="settings-navigation__items" key={group.join('-')}>
            {group.map((id) => {
              const active = id === activeSection
              const Glyph = SECTIONS[id].icon

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
                  <Glyph aria-hidden="true" className="settings-navigation__icon" />

                  <span>{SECTIONS[id].label}</span>
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

interface SettingsPanelProps {
  readonly settings: AppSettings
  readonly controller: SettingsController
}

/*
 * 通用页放的是"这台软件怎么陪你干活"，不是杂物抽屉。
 *
 * 三件事按用户心智分组：说话（怎么发出去、干完了怎么告诉我）、后悔（删之前拦
 * 一下）、重来（全部还原）。这也是 Codex / VS Code 一类工具在这一页的形态 ——
 * 通用不是"没地方放的东西"的集合，而是每次会话都会碰到的那几条。
 */
const GeneralSettings = memo(function GeneralSettings({
  settings,
  controller,
}: SettingsPanelProps) {
  return (
    <SettingsPage>
      <SettingsGroup title="对话">
        <ToggleRow
          checked={settings.general.sendWithModifier}
          description="开启后 Enter 换行，Ctrl / ⌘ + Enter 发送；关闭时相反"
          label="用修饰键发送"
          onChange={(checked) => {
            controller.update((current) => ({
              ...current,
              general: { ...current.general, sendWithModifier: checked },
            }))
          }}
        />

        <ToggleRow
          checked={settings.general.notifyOnCompletion}
          description="长任务结束时发一条系统通知，窗口在前台时不打扰"
          label="完成时通知"
          onChange={(checked) => {
            controller.update((current) => ({
              ...current,
              general: { ...current.general, notifyOnCompletion: checked },
            }))
          }}
        />
      </SettingsGroup>

      <SettingsGroup title="启动项">
        <ToggleRow
          checked={settings.general.daemon}
          description="在后台守着本地 Agent 进程：意外退出时自动重起。关闭后它只在对话进行时存在"
          label="守护进程"
          onChange={(checked) => {
            controller.update((current) => ({
              ...current,
              general: { ...current.general, daemon: checked },
            }))
          }}
        />
      </SettingsGroup>

      <SettingsGroup title="安全">
        <ToggleRow
          checked={settings.general.confirmBeforeDelete}
          description="删除对话前再确认一次"
          label="删除前确认"
          onChange={(checked) => {
            controller.update((current) => ({
              ...current,
              general: { ...current.general, confirmBeforeDelete: checked },
            }))
          }}
        />
      </SettingsGroup>

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

/*
 * 两张静态表，和 SECTIONS / SECTION_GROUPS 一样属于模块。
 *
 * 形状直接写成基元认的那一种：类型参数保住"只可能是这几个字面量"，
 * onValueChange 的入参因此就是 AppSettings 上那个字段本身，末端不欠一次断言。
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

const DENSITIES: readonly SelectOption<AppSettings['appearance']['density']>[] = [
  { value: 'comfortable', label: '宽松' },
  { value: 'compact', label: '紧凑' },
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

      <SettingsGroup title="界面">
        <SettingRow description="列表与消息之间的留白" label="显示密度">
          <Select
            align="end"
            className="settings-select-trigger"
            data={DENSITIES}
            onValueChange={(density) => {
              controller.update((current) => ({
                ...current,
                appearance: { ...current.appearance, density },
              }))
            }}
            type="显示密度"
            value={settings.appearance.density}
          />
        </SettingRow>

        <ToggleRow
          checked={settings.appearance.reduceMotion}
          description="关掉过渡与位移动画，只保留状态变化"
          label="减少动效"
          onChange={(checked) => {
            controller.update((current) => ({
              ...current,
              appearance: { ...current.appearance, reduceMotion: checked },
            }))
          }}
        />

        <ToggleRow
          checked={settings.appearance.messageTimestamps}
          description="在每条消息旁显示发生时间"
          label="消息时间戳"
          onChange={(checked) => {
            controller.update((current) => ({
              ...current,
              appearance: { ...current.appearance, messageTimestamps: checked },
            }))
          }}
        />
      </SettingsGroup>

      <MascotPrefsGroup />
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
              privacy: { ...current.privacy, telemetry: checked },
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
              privacy: { ...current.privacy, crashReporting: checked },
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
              privacy: { ...current.privacy, updateCheck: checked },
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
   * tools/release/check-versions.ts 只对齐 package.json、Cargo.toml 与
   * tauri.conf.json 那三个，扫不到一段 JSX 里的字符串。
   *
   * 读不出来就不写出一个数。一个说错了的版本号比一个没说出来的有害得多。
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
   * 渲染层没有第二种算法：安装期可以把数据目录指到任何地方，"%LOCALAPPDATA%
   * 加产品名"这个假设在那一刻就不成立了。一条说错了的路径会把用户的备份引到
   * 一个空目录。
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
        <ArchitecturePrinciple description="统一各类Agent交互规范" index="01" title="Agent 集成" />

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
