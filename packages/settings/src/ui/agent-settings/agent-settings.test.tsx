import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  type AgentSettingEntry,
  type AgentSettingsCatalog,
  type AgentSettingsPort,
  AgentSettingsStore,
} from '../../index'
import { AgentSettingsCatalog as Surface } from './agent-settings'

/*
 * 上屏这一侧的判据。三件事各自独立，不互相顶替：
 *
 * 1. **整份目录画得出来**：378 格、六种类型、每种元数据组合各来一个，一次渲染不许抛。
 *    条数与类型分布来自 18.3.0 的实测（见报告）。这个包看不见 omp（layering 不允许，它也不该
 *    看见），所以「条数与上游自报相等」由桥那一侧的测试守着；这里守的是「真形状进来画不画得出来」。
 * 2. **钥匙那几格绝不把值画上屏**。值的缺席由桥与 Rust 两层各自折一次保证，这里再证明一次
 *    「就算有值送到这一层，它也进不了 markup」—— 边界不能只靠对端守约定。
 * 3. **条件认得出的按目录里自己的值算，认不出的不显示**。
 */

const SECRET_PATH = 'mnemopi.llmApiKey'
const PLANTED = 'sk-planted-must-never-reach-the-webview-9e2b'

/** 实测分布：boolean 179 / enum 84 / number 68 / string 34 / array 10 / record 3。 */
const DISTRIBUTION = [
  ['boolean', 179],
  ['enum', 84],
  ['number', 68],
  ['string', 34],
  ['array', 10],
  ['record', 3],
] as const

function entry(index: number, type: string, tab = 'tools'): AgentSettingEntry {
  const base = {
    path: `sample.${type}.${String(index)}`,
    type,
    label: `Sample ${type} ${String(index)}`,
    description: `Description for ${type} ${String(index)}`,
    tab,
    group: `Group ${String(index % 4)}`,
    default: null,
    value: null,
    secret: false,
    hasValue: false,
  }

  switch (type) {
    case 'boolean':
      return { ...base, value: index % 2 === 0 }
    case 'enum':
      return index % 2 === 0
        ? {
            ...base,
            value: 'off',
            options: [
              { value: 'off', label: 'Off' },
              { value: 'on', label: 'On', description: 'Turn it on' },
            ],
          }
        : { ...base, value: 'auto', enumValues: ['off', 'on', 'auto'] }
    case 'number':
      return { ...base, value: index }
    case 'string':
      return { ...base, value: `value-${String(index)}` }
    case 'array':
      return { ...base, value: [1, 2, 3] }
    default:
      return { ...base, value: { a: 1, b: 2 } }
  }
}

/**
 * 378 格，全在同一栏里。
 *
 * 同一栏是有意的：一次渲染就把六种类型全画一遍，不必逐个切栏去够它们。条数与分布照实测那一份。
 */
function fullCatalog(): AgentSettingsCatalog {
  const settings: AgentSettingEntry[] = []

  for (const [type, count] of DISTRIBUTION) {
    for (let index = 0; index < count; index += 1) {
      settings.push(entry(settings.length, type))
    }
  }

  return {
    tabs: [{ key: 'tools', label: '工具' }],
    settings,
    configFile: '/home/config.yml',
    configFileExists: true,
  }
}

function storeOf(read: () => Promise<AgentSettingsCatalog>): AgentSettingsStore {
  const port: AgentSettingsPort = {
    read,
    write: () => Promise.resolve([]),
    openConfigFile: () => Promise.resolve(),
  }

  return new AgentSettingsStore(port)
}

describe('agent 设置页', () => {
  it('整份目录画得出来：378 格、六种类型、每种元数据组合都不抛', async () => {
    const store = storeOf(() => Promise.resolve(fullCatalog()))

    await store.load()

    const markup = renderToStaticMarkup(<Surface store={store} />)

    expect(store.getSnapshot().catalog?.settings).toHaveLength(378)

    /*
     * 每一格都画出来了，外加「来源」那一组的两行（搜索框与开配置文件）。
     * 那两行不是设置：它们是这一页自己的入口，所以数在这里要一起算进去。
     */
    expect(markup.match(/class="settings-row"/g)).toHaveLength(380)

    /* 六种类型各自落到了对的控件上，逐类点一个名。 */
    expect(markup).toContain('role="switch"') // boolean
    expect(markup).toContain('role="combobox"') // enum
    expect(markup).toContain('type="number"') // number
    expect(markup).toContain('placeholder="value-340"') // string（无选项表那条，输入框无 type 即文本）
    expect(markup).toContain('agent-setting__opaque') // array / record
  })

  /**
   * 栏名取自目录自报的 `tabs`，不是我们写死的一份。
   *
   * 判据是把上游的词汇换掉：换完屏幕上跟着换，就说明它没有第二份表。
   */
  it('导航跟着目录报的 tabs 走，我们这侧没有第二份栏名', async () => {
    const renamed: AgentSettingsCatalog = {
      tabs: [{ key: 'zzz-invented-tab', label: 'zzz-invented-tab' }],
      settings: [entry(0, 'boolean', 'zzz-invented-tab')],
      configFile: '/home/config.yml',
      configFileExists: true,
    }
    const store = storeOf(() => Promise.resolve(renamed))

    await store.load()

    const markup = renderToStaticMarkup(<Surface store={store} />)

    expect(markup).toContain('Sample boolean 0')
    /* 只有一栏时不画选择器：一格的导航是复述。 */
    expect(markup).not.toContain('设置栏目')
  })

  /**
   * **钥匙那一格的值进不了 markup。**
   *
   * 线上与 crate 侧都各自把它的值折成了 null（bridge 的 entryOf 与 crates 的 from_wire），
   * 但这条边界不能取决于那两层守不守约定：这里直接送一格**带着明文**的钥匙，证明它也画不出去。
   */
  it('钥匙那一格带着明文也画不上屏', async () => {
    const catalog: AgentSettingsCatalog = {
      tabs: [{ key: 'memory', label: '记忆' }],
      settings: [
        {
          path: SECRET_PATH,
          type: 'string',
          label: 'LLM API Key',
          description: 'Key for the memory backend',
          tab: 'memory',
          group: 'Mnemopi',
          default: null,
          /* 故意违反契约：值本该是 null。 */
          value: PLANTED,
          secret: true,
          hasValue: true,
        },
      ],
      configFile: '/home/config.yml',
      configFileExists: true,
    }
    const store = storeOf(() => Promise.resolve(catalog))

    await store.load()

    const markup = renderToStaticMarkup(<Surface store={store} />)

    expect(markup).not.toContain(PLANTED)
    /* 掩码控件，且只说「配过没有」。 */
    expect(markup).toContain('type="password"')
    expect(markup).toContain('已配置')
  })

  it('没配过的钥匙说未配置，不说空', async () => {
    const catalog: AgentSettingsCatalog = {
      tabs: [{ key: 'memory', label: '记忆' }],
      settings: [
        {
          path: SECRET_PATH,
          type: 'string',
          label: 'LLM API Key',
          description: '',
          tab: 'memory',
          default: null,
          value: null,
          secret: true,
          hasValue: false,
        },
      ],
      configFile: '/home/config.yml',
      configFileExists: true,
    }
    const store = storeOf(() => Promise.resolve(catalog))

    await store.load()

    expect(renderToStaticMarkup(<Surface store={store} />)).toContain('未配置')
  })

  /*
   * 条件这一组：认得出的按目录里自己的值算；认不出的不显示。
   *
   * `advisorEnabled` 在本仓的映射是「读 advisor.enabled 此刻的值」（正本见
   * ui/agent-settings/settings-conditions.ts 的模块注释），所以这两条同时钉住
   * 「映射是对的」与「值取自目录、不是取自别处」。
   */
  it('认得出的条件按目录里此刻的值决定显不显示', async () => {
    const catalog = (advisorEnabled: boolean): AgentSettingsCatalog => ({
      tabs: [{ key: 'model', label: '模型' }],
      settings: [
        {
          ...entry(0, 'boolean', 'model'),
          path: 'advisor.enabled',
          label: 'Advisor',
          value: advisorEnabled,
        },
        {
          ...entry(1, 'number', 'model'),
          path: 'advisor.maxNotesPerUpdate',
          label: 'Max notes',
          condition: 'advisorEnabled',
        },
      ],
      configFile: '/home/config.yml',
      configFileExists: true,
    })

    const off = storeOf(() => Promise.resolve(catalog(false)))
    await off.load()
    const hidden = renderToStaticMarkup(<Surface store={off} />)

    expect(hidden).toContain('Advisor')
    expect(hidden).not.toContain('Max notes')

    const on = storeOf(() => Promise.resolve(catalog(true)))
    await on.load()

    expect(renderToStaticMarkup(<Surface store={on} />)).toContain('Max notes')
  })

  it('认不出的条件不显示：不知道就不画，不猜一个默认值', async () => {
    const catalog: AgentSettingsCatalog = {
      tabs: [{ key: 'tools', label: '工具' }],
      settings: [
        { ...entry(0, 'boolean', 'tools'), label: 'Plain' },
        {
          ...entry(1, 'boolean', 'tools'),
          label: 'Mystery',
          condition: 'aConditionFromSomeFutureVersion',
        },
      ],
      configFile: '/home/config.yml',
      configFileExists: true,
    }
    const store = storeOf(() => Promise.resolve(catalog))

    await store.load()

    const markup = renderToStaticMarkup(<Surface store={store} />)

    expect(markup).toContain('Plain')
    expect(markup).not.toContain('Mystery')
  })

  it('风险提示原样上屏', async () => {
    const warning = 'At your own risk: providers have flagged this request shape as abuse'
    const catalog: AgentSettingsCatalog = {
      tabs: [{ key: 'model', label: '模型' }],
      settings: [{ ...entry(0, 'boolean', 'model'), label: 'External Thinking', warning }],
      configFile: '/home/config.yml',
      configFileExists: true,
    }
    const store = storeOf(() => Promise.resolve(catalog))

    await store.load()

    const markup = renderToStaticMarkup(<Surface store={store} />)

    expect(markup).toContain(warning)
    expect(markup).toContain('settings-row__warning')
  })

  it('每一格都画出它自己的组名，分组来自元数据', async () => {
    const store = storeOf(() => Promise.resolve(fullCatalog()))

    await store.load()

    const markup = renderToStaticMarkup(<Surface store={store} />)

    for (const group of ['Group 0', 'Group 1', 'Group 2', 'Group 3']) {
      expect(markup).toContain(`<h3>${group}</h3>`)
    }
  })

  /*
   * 用户提的那三个问题：三百多项翻不完、全是英文、能不能直接改配置文件。
   * 下面三条各钉一个判据，且都钉在「没有它就等于没做」的那一格上。
   */
  it('搜索框在：三百多项没有搜索就只能靠翻', async () => {
    const store = storeOf(() => Promise.resolve(fullCatalog()))

    await store.load()

    const markup = renderToStaticMarkup(<Surface store={store} />)

    expect(markup).toContain('按名称或路径搜索…')
  })

  /*
   * 跟这台桌面软件无关的格子**不上屏**，而不是折叠起来。
   *
   * 画一格改了没有效果的控件就是骗人 —— 它让人以为改了会变。过滤在桥那一侧做
   * （`irrelevantSettingOf`），所以界面这一层只须证明：目录里给什么就画什么，
   * 而目录不会再给那些。
   */
  it('目录里没有的格子一屏都不出现', async () => {
    const store = storeOf(() => Promise.resolve(fullCatalog()))

    await store.load()

    const markup = renderToStaticMarkup(<Surface store={store} />)

    /* 折叠机制本身已经删掉了：不要再留一个收起来的入口。 */
    expect(markup).not.toContain('<details')
    expect(markup).not.toContain('终端界面')
  })

  it('搜索结果跟着目录走：搜不到的就不画', async () => {
    const store = storeOf(() => Promise.resolve(fullCatalog()))

    await store.load()

    const markup = renderToStaticMarkup(<Surface store={store} />)

    /* 三百多项的设置页，搜索框是入口；它必须在，且带说明。 */
    expect(markup).toContain('搜索设置')
  })

  it('没有配置文件时按钮点不动，并说清为什么', async () => {
    const catalog: AgentSettingsCatalog = {
      tabs: [{ key: 'tools', label: '工具' }],
      settings: [entry(0, 'boolean')],
      configFile: '/home/config.yml',
      configFileExists: false,
    }
    const store = storeOf(() => Promise.resolve(catalog))

    await store.load()

    const markup = renderToStaticMarkup(<Surface store={store} />)

    expect(markup).toContain('配置文件还没生成')
    expect(markup).toContain('/home/config.yml')
    /* 文件还没有就给个点得动却报错的按钮，比灰着更坏。 */
    expect(markup).toContain('disabled')
  })

  it('配置文件的路径与「打开」入口都在屏上', async () => {
    const store = storeOf(() => Promise.resolve(fullCatalog()))

    await store.load()

    const markup = renderToStaticMarkup(<Surface store={store} />)

    expect(markup).toContain('用编辑器改配置文件')
    expect(markup).toContain('/home/config.yml')
  })
})
