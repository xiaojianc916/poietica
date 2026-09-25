import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ToolCallContent, ToolKind } from '../../agent/tool-call'
import { ompToolView } from '../omp-tool-view'

// 只测「画什么」：主语、那一行字、两面与形状。上色与虚拟化归 surface。

// 产出的信封：AgentToolResult 的 content 块。
function envelope(...blocks: readonly unknown[]): { readonly content: readonly unknown[] } {
  return { content: blocks }
}
const textBlock = (text: string): unknown => ({ type: 'text', text })
const imageBlock = (data: string, mimeType = 'image/png'): unknown => ({
  type: 'image',
  data,
  mimeType,
})

function kinds(view: { readonly request: readonly ToolCallContent[] }): readonly string[] {
  return view.request.map((part) => part.type)
}

describe('ompToolView 读文件', () => {
  it('打开就是那份文件：一面，按扩展名上色', () => {
    const view = ompToolView('read', { path: 'src/app.rs' }, envelope(textBlock('fn main() {}')))

    expect(view.kind).toBe('read')
    expect(view.headline).toBe('阅读 src/app.rs')
    expect(view.subject).toBe('src/app.rs')
    expect(view.shape).toBe('result')
    expect(view.request).toHaveLength(0)
    expect(view.response).toHaveLength(1)
    expect(view.response[0]).toEqual({
      type: 'command',
      command: 'fn main() {}',
      language: 'rust',
    })
  })

  it('带选择器的路径仍然认得出扩展名', () => {
    const view = ompToolView('read', { path: 'src/app.ts:10-20' }, envelope(textBlock('x')))

    expect(view.response[0]?.type === 'command' && view.response[0].language).toBe('typescript')
  })

  it('产出的 details 里有给人看的那份原始正文时用它，而不是带行号前缀的那份', () => {
    const view = ompToolView(
      'read',
      { path: 'a.ts' },
      {
        content: [textBlock('1|const a = 1')],
        details: { displayContent: { text: 'const a = 1', startLine: 1 } },
      },
    )

    expect(view.response[0]?.type === 'command' && view.response[0].command).toBe('const a = 1')
  })
})

describe('ompToolView 跑命令', () => {
  it('命令与它的输出上下相接，退出码落在产出那面', () => {
    const view = ompToolView(
      'bash',
      { command: 'bun test\nbun lint' },
      { content: [textBlock('42 pass')], details: { exitCode: 1 } },
    )

    expect(view.kind).toBe('execute')
    expect(view.headline).toBe('bun test')
    expect(view.shape).toBe('flow')
    expect(view.request).toEqual([
      { type: 'command', command: 'bun test\nbun lint', language: 'bash' },
    ])
    expect(view.response[0]).toEqual({
      type: 'content',
      content: { type: 'text', text: '42 pass' },
    })
    expect(view.response.at(-1)?.type).toBe('prose')
  })

  it('退出码为零不点出来', () => {
    const view = ompToolView('bash', { command: 'ls' }, { content: [textBlock('a')], details: {} })

    expect(view.response).toHaveLength(1)
  })

  it('失败时那句话顶替产出', () => {
    const view = ompToolView('bash', { command: 'exit 1' }, envelope(textBlock('stdout')), 'boom')

    expect(view.response).toHaveLength(1)
    expect(view.response[0]?.type === 'content' && view.response[0].content).toEqual({
      type: 'text',
      text: 'boom',
    })
  })
})

describe('ompToolView 改文件', () => {
  it('默认的 hashline 模式：入参只有补丁正文，结构与新旧正文从产出的 details 里取', () => {
    const view = ompToolView(
      'edit',
      { input: '[src/a.ts#1a2b]\nreplace 1..1:\n+const a = 2' },
      {
        content: [textBlock('ok')],
        details: { path: '/repo/src/a.ts', oldText: 'const a = 1', newText: 'const a = 2' },
      },
    )

    expect(view.kind).toBe('edit')
    expect(view.shape).toBe('diff')
    expect(view.request[0]).toEqual({
      type: 'diff',
      path: '/repo/src/a.ts',
      oldText: 'const a = 1',
      newText: 'const a = 2',
    })
  })

  it('多文件改动按 perFileResults 逐处给出', () => {
    const view = ompToolView(
      'edit',
      { input: 'patch' },
      {
        content: [textBlock('ok')],
        details: {
          perFileResults: [
            { path: 'a.ts', oldText: 'a', newText: 'b' },
            { path: 'b.ts', newText: 'c' },
          ],
        },
      },
    )

    expect(view.request).toHaveLength(2)
    expect(view.request[0]?.type === 'diff' && view.request[0].path).toBe('a.ts')
    expect(view.request[1]?.type === 'diff' && view.request[1].path).toBe('b.ts')
  })

  it('replace 模式下退回入参的新旧文本', () => {
    const view = ompToolView(
      'edit',
      { path: 'a.ts', old_string: 'const a = 1', new_string: 'const a = 2' },
      envelope(textBlock('ok')),
    )

    expect(view.request[0]).toEqual({
      type: 'diff',
      path: 'a.ts',
      oldText: 'const a = 1',
      newText: 'const a = 2',
    })
  })

  it('交不出新旧正文时把补丁正文本身画出来，而不是假装那是一处改动', () => {
    const view = ompToolView('edit', { input: '@@ -1 +1 @@' }, envelope(textBlock('ok')))

    expect(view.request).toEqual([{ type: 'command', command: '@@ -1 +1 @@', language: 'diff' }])
  })
})

describe('ompToolView 查找', () => {
  it('grep 的主语是模式，不是路径', () => {
    const view = ompToolView(
      'grep',
      { pattern: '未完成', path: 'src' },
      { content: [textBlock('a.ts:1: 未完成')], details: { matchCount: 3 } },
    )

    expect(view.headline).toBe('搜索 未完成')
    expect(view.subject).toBe('未完成')
    expect(view.shape).toBe('result')
    expect(view.response.at(-1)?.type).toBe('prose')
  })

  it('glob 的模式住在 path 字段里', () => {
    const view = ompToolView('glob', { path: '**/*.png' }, { content: [textBlock('a.png')] })

    expect(view.headline).toBe('按模式查找 **/*.png')
    expect(view.subject).toBe('**/*.png')
  })

  it('find 是语义查找，主语是那段描述', () => {
    const view = ompToolView(
      'find',
      { query: '处理重连的地方', grep_keywords: ['reconnect'] },
      { content: [textBlock('a.ts')] },
    )

    expect(view.headline).toBe('语义查找 处理重连的地方')
  })

  it('ast_grep 的主语是 pat 不是 pattern', () => {
    const view = ompToolView('ast_grep', { pat: 'console.log($A)' }, { content: [textBlock('a')] })

    expect(view.headline).toBe('AST 搜索 console.log($A)')
  })
})

describe('ompToolView 任务清单', () => {
  it('产出里的 phases 是正本：分段、四档状态各有记号', () => {
    const view = ompToolView(
      'todo',
      { op: 'view' },
      {
        content: [textBlock('ok')],
        details: {
          op: 'view',
          storage: 'session',
          phases: [
            {
              name: '第一阶段',
              tasks: [
                { content: '建索引', status: 'completed' },
                { content: '写测试', status: 'in_progress' },
                { content: '废弃项', status: 'abandoned' },
              ],
            },
          ],
        },
      },
    )

    expect(view.kind).toBe('todo')
    expect(view.headline).toBe('查看任务清单')
    expect(view.shape).toBe('result')
    const body = view.response[0]
    expect(body?.type === 'prose' && body.text).toContain('- [x] 建索引')
    expect(body?.type === 'prose' && body.text).toContain('- [ ] 写测试（进行中）')
    expect(body?.type === 'prose' && body.text).toContain('- [~] 废弃项（已丢弃）')
  })

  it('还没有产出时照入参的 list 画，每一档 op 有自己的说法', () => {
    const view = ompToolView(
      'todo',
      { op: 'init', list: [{ phase: '第一阶段', items: ['a', 'b'] }] },
      undefined,
    )

    expect(view.headline).toBe('初始化任务清单')
    const body = view.request[0]
    expect(body?.type === 'prose' && body.text).toContain('- [ ] a')
    expect(body?.type === 'prose' && body.text).toContain('- [ ] b')
  })

  it('平铺的 init 也画得出来', () => {
    const view = ompToolView('todo', { op: 'append', items: ['c'] }, undefined)

    expect(view.headline).toBe('追加任务')
    expect(view.request[0]?.type === 'prose' && view.request[0].text).toContain('- [ ] c')
  })
})

describe('ompToolView 浏览器与桌面', () => {
  it('截图折进产出那面，动作与网址进那一行', () => {
    const view = ompToolView(
      'browser',
      { action: 'open', name: 'main', url: 'https://x' },
      envelope(textBlock('Opened tab'), imageBlock('QUJD')),
    )

    expect(view.headline).toBe('浏览器 打开 https://x')
    expect(view.response.at(-1)).toEqual({
      type: 'content',
      content: { type: 'image', data: 'QUJD', mimeType: 'image/png' },
    })
  })

  it('run 把脚本画成代码', () => {
    const view = ompToolView(
      'browser',
      { action: 'run', name: 'main', code: 'await tab.goto("https://x")' },
      envelope(textBlock('done')),
    )

    expect(view.request[0]).toEqual({
      type: 'command',
      command: 'await tab.goto("https://x")',
      language: 'javascript',
    })
  })

  it('桌面控制的每一档动作有自己的说法', () => {
    expect(ompToolView('computer', { action: 'capabilities' }, envelope()).headline).toBe(
      '桌面控制 · 查看能力',
    )
    expect(
      ompToolView('computer', { action: 'run', code: 'desktop.type()' }, envelope()).headline,
    ).toBe('桌面控制 · 执行脚本')
  })
})

describe('ompToolView eval 里的浏览器与桌面', () => {
  /*
   * 真正的那条路在这里。
   *
   * browser / computer 不是顶层工具 —— 它们是注入 eval 内核的作用域对象（omp 的
   * createBrowserPrelude / createComputerPrelude，经 eval/preludes.ts 注册）。模型写
   * `browser.open(...)`，帧名永远是 eval，那件事记在产出的 details.statusEvents 里：
   * `[{ op: 'browser', detail: 'open main https://…' }]`。
   *
   * 不把这一段挑出来，一次「用浏览器打开某页」在屏幕上只会显示成「运行 JavaScript」。
   */
  it('产出里的 prelude 事件报成那件事，而不是「运行 JavaScript」', () => {
    const view = ompToolView(
      'eval',
      { language: 'js', code: 'await browser.open("https://x")' },
      {
        content: [textBlock('opened')],
        details: { statusEvents: [{ op: 'browser', detail: 'open main https://x' }] },
      },
    )

    expect(view.headline).toBe('浏览器 open main https://x')
    expect(view.subject).toBe('浏览器 open main https://x')
  })

  it('多个 prelude 事件按发生顺序接起来', () => {
    const view = ompToolView(
      'eval',
      { language: 'js', code: 'await desktop.click()' },
      {
        content: [textBlock('ok')],
        details: {
          statusEvents: [
            { op: 'browser', detail: 'open main https://x' },
            { op: 'computer', detail: 'click(10, 20)' },
          ],
        },
      },
    )

    expect(view.headline).toBe('浏览器 open main https://x；桌面控制 click(10, 20)')
  })

  it('事件挂在 cell 上也认得', () => {
    const view = ompToolView(
      'eval',
      { language: 'js', code: 'browser.tabs()' },
      {
        content: [textBlock('ok')],
        details: {
          cells: [
            { index: 0, code: 'browser.tabs()', statusEvents: [{ op: 'browser', detail: 'tabs' }] },
          ],
        },
      },
    )

    expect(view.headline).toBe('浏览器 tabs')
  })

  it('没有 prelude 事件的 eval 仍然是「运行 JavaScript」', () => {
    const view = ompToolView('eval', { language: 'js', code: '1 + 1' }, envelope(textBlock('2')))

    expect(view.headline).toBe('运行 JavaScript · 1 + 1')
  })

  it('认不出的 op 不当成 prelude', () => {
    const view = ompToolView(
      'eval',
      { language: 'js', code: 'x' },
      { content: [textBlock('ok')], details: { statusEvents: [{ op: 'mystery', detail: 'x' }] } },
    )

    expect(view.headline).toBe('运行 JavaScript · x')
  })

  /* 官方视图表把 js / python / notebook 都指到同一个渲染器；名字自己就说了语言。 */
  it('eval 的别名按自己的语言报，而不是一律 JavaScript', () => {
    expect(ompToolView('python', { code: 'print(1)' }, envelope(textBlock('1'))).headline).toBe(
      '运行 Python · print(1)',
    )
    expect(ompToolView('js', { code: '1 + 1' }, envelope(textBlock('2'))).headline).toBe(
      '运行 JavaScript · 1 + 1',
    )
    /* 入参里的 language 比别名更权威：别名只是默认值。 */
    expect(
      ompToolView('python', { language: 'js', code: 'x' }, envelope(textBlock('y'))).headline,
    ).toBe('运行 JavaScript · x')
  })

  it('浏览器别名与 fetch 别名各按自己的工具画', () => {
    const puppeteer = ompToolView(
      'puppeteer',
      { action: 'open', url: 'https://x' },
      envelope(textBlock('ok')),
    )
    expect(puppeteer.headline).toBe('浏览器 打开 https://x')
    expect(puppeteer.kind).toBe('fetch')

    /* fetch 是官方视图表给 read 登记的别名：它读的就是一个地址。 */
    expect(ompToolView('fetch', { path: 'https://x' }, envelope(textBlock('ok'))).kind).toBe('read')
  })
})

describe('ompToolView 其余工具各自说自己的话', () => {
  const cases: readonly (readonly [string, unknown, ToolKind, string])[] = [
    ['web_search', { query: 'omp' }, 'fetch', '联网搜索 omp'],
    ['recall', { query: '上次的决定' }, 'search', '回忆 上次的决定'],
    ['reflect', { query: '为什么慢' }, 'other', '反思 为什么慢'],
    ['github', { op: 'pr_create', title: '修好它' }, 'fetch', 'GitHub 创建 PR 修好它'],
    ['lsp', { action: 'diagnostics', file: 'a.ts' }, 'read', '读取诊断 a.ts'],
    [
      'debug',
      { action: 'set_breakpoint', file: 'a.ts', line: 3 },
      'other',
      '调试 set breakpoint a.ts',
    ],
    ['checkpoint', { goal: '查清竞态' }, 'other', '设立检查点 查清竞态'],
    ['rewind', { report: '是锁顺序反了' }, 'other', '回退到检查点 是锁顺序反了'],
    ['goal', { op: 'create', objective: '修好登录' }, 'goal', '立下目标 修好登录'],
    ['security_scan', { action: 'preflight' }, 'other', '安全扫描 preflight'],
    ['retain', { items: [{ content: '用户偏好中文' }] }, 'other', '记住 1 条'],
    ['manage_skill', { action: 'delete', name: 'review' }, 'skill', '删除技能 review'],
    ['generate_image', { subject: '一只猫' }, 'other', '生成图片 一只猫'],
    ['tts', { text: '你好', output_path: 'a.mp3' }, 'other', '合成语音 你好'],
    ['vibe_spawn', { cli: 'fast', prompt: '跑一下' }, 'delegate', '启动 vibe 会话（fast）'],
    ['new_context', {}, 'other', '开启新上下文'],
    ['wait', {}, 'other', '等待后台结果'],
    ['yield', { type: 'final', data: { ok: true } }, 'other', '交出结果'],
  ]

  for (const [name, input, kind, headline] of cases) {
    it(`${name} → ${headline}`, () => {
      const view = ompToolView(name, input, envelope(textBlock('x')))

      expect(view.kind).toBe(kind)
      expect(view.headline).toBe(headline)
    })
  }

  it('eval 按语言上色，title 优先当那一行', () => {
    const view = ompToolView(
      'eval',
      { language: 'py', code: 'print(1)', title: '算一下' },
      envelope(textBlock('1')),
    )

    expect(view.headline).toBe('运行 Python · 算一下')
    expect(view.request[0]?.type === 'command' && view.request[0].language).toBe('python')
  })

  it('ask 把题面与选项都摊开', () => {
    const view = ompToolView(
      'ask',
      {
        questions: [
          {
            id: 'q1',
            question: '走哪条路？',
            options: [{ label: '甲', description: '快' }, { label: '乙' }],
          },
        ],
      },
      envelope(textBlock('选了甲')),
    )

    expect(view.headline).toBe('询问 走哪条路？')
    expect(view.request[0]?.type === 'prose' && view.request[0].text).toContain('走哪条路？')
    expect(view.request[1]?.type === 'command' && view.request[1].command).toContain('甲 —— 快')
  })

  it('task 批量时每个子任务各占一节', () => {
    const view = ompToolView(
      'task',
      {
        context: '背景',
        tasks: [
          { name: '甲', task: '做甲' },
          { name: '乙', task: '做乙' },
        ],
      },
      envelope(textBlock('done')),
    )

    expect(view.headline).toBe('派发子代理 2 个子代理')
    const body = view.request.at(-1)
    expect(body?.type === 'prose' && body.text).toContain('## 甲')
    expect(body?.type === 'prose' && body.text).toContain('## 乙')
  })

  it('think 只说一句话，不留两面', () => {
    const view = ompToolView('think', { thoughts: '再想想\n第二行' }, envelope())

    expect(view.headline).toBe('再想想')
    expect(view.request).toHaveLength(0)
    expect(view.response).toHaveLength(0)
  })

  it('search 是 omp 自己的历史别名，按 grep 认', () => {
    expect(ompToolView('search', { pattern: 'x' }, envelope()).headline).toBe('搜索 x')
  })
})

describe('ompToolView 认不出的名字', () => {
  it('认不出的工具交回空视图，让抽屉走 JSON 兜底', () => {
    const view = ompToolView('mystery', { a: 1 }, envelope(textBlock('x')))

    expect(view.headline).toBe('')
    expect(view.request).toHaveLength(0)
    expect(view.response).toHaveLength(0)
    expect(view.shape).toBe('tabs')
  })

  it('MCP 工具认前缀：服务器与工具名原样报出来，类别按入参形状猜', () => {
    const view = ompToolView('mcp__srv__run', { path: 'a.ts' }, envelope(textBlock('x')))

    expect(view.known).toBe(true)
    expect(view.headline).toBe('srv · run')
    expect(view.kind).toBe('read')
    expect(view.subject).toBe('srv · run')
  })

  it('MCP 名字里没有分隔符时整段报出来', () => {
    expect(ompToolView('mcp__solo', {}, envelope()).headline).toBe('solo')
  })
})

describe('ompToolView 图片', () => {
  it('任何工具带回的图都追加到产出那面', () => {
    const view = ompToolView(
      'generate_image',
      { subject: '猫' },
      { content: [textBlock('saved')], details: { imagePaths: ['/tmp/a.png'] } },
    )

    expect(kinds(view)).toEqual([])
    expect(view.response.at(-1)?.type).toBe('content')
  })

  it('read 一张图时图也在产出那面', () => {
    const view = ompToolView('read', { path: 'a.png' }, envelope(imageBlock('QUJD', 'image/webp')))

    expect(view.response.at(-1)).toEqual({
      type: 'content',
      content: { type: 'image', data: 'QUJD', mimeType: 'image/webp' },
    })
  })
})

describe('ompToolView 后台调用', () => {
  it('产出报了 async 就是后台调用', () => {
    const view = ompToolView(
      'bash',
      { command: 'sleep 600' },
      {
        content: [textBlock('started')],
        details: { async: { state: 'running', jobId: 'j1', type: 'bash' } },
      },
    )

    expect(view.background).toBe(true)
  })

  it('前台调用不是后台', () => {
    expect(ompToolView('bash', { command: 'ls' }, envelope(textBlock('a'))).background).toBe(false)
  })
})

describe('ompToolView 快照被裁掉的改动', () => {
  it('没有成对正文时画产出自己算好的统一 diff', () => {
    const view = ompToolView(
      'edit',
      { input: '[src/a.ts#1a2b]\nreplace 1..1' },
      {
        content: [textBlock('ok')],
        details: { path: 'src/a.ts', snapshotsPruned: true, diff: '@@ -1 +1 @@\n-a\n+b' },
      },
    )

    expect(view.request[0]?.type).toBe('command')
    expect(view.request[0]?.type === 'command' && view.request[0].command).toContain('@@ -1 +1 @@')
  })
})

describe('ompToolView 覆盖 omp 自己报的每一个工具名', () => {
  /*
   * 正本不手抄。
   *
   * 依赖是可升级的（agent-bridge 钉 ^18.3.0），而这张表当初是照着某一版手抄下来的 ——
   * 上游新增一个工具名，这里不会红，屏幕上却会退成裸 JSON。所以改成读**装到的那一份**
   * SDK 自己的 builtin-names.ts：升级换版本时这一条跟着变，加名字就失败。
   */
  const SDK_SOURCE = readFileSync(
    `${fileURLToPath(import.meta.resolve('@oh-my-pi/pi-coding-agent')).replace(/[\\/]src[\\/]index\.ts$/, '')}/src/tools/builtin-names.ts`,
    'utf8',
  )

  /** 从 `export const X = [ ... ] as const` 里取出字符串字面量。 */
  function namesIn(constant: string): readonly string[] {
    const body = new RegExp(`${constant} = \\[([\\s\\S]*?)\\] as const`).exec(SDK_SOURCE)?.[1] ?? ''

    return (body.match(/"([a-z_0-9]+)"/g) ?? []).map((quoted) => quoted.slice(1, -1))
  }

  const SDK_NAMES = [...namesIn('BUILTIN_TOOL_NAMES'), ...namesIn('HIDDEN_TOOL_NAMES')]

  it('正本读得出名字（读不到就是路径或形状变了，不是通过）', () => {
    expect(SDK_NAMES.length).toBeGreaterThan(20)
  })

  for (const name of SDK_NAMES) {
    it(`${name} 认得`, () => {
      expect(ompToolView(name, {}, envelope(textBlock('x'))).known).toBe(true)
    })
  }

  /* 上游的历史别名（LEGACY_BUILTIN_TOOL_NAME_ALIASES）同样要有视图。 */
  it('上游登记的历史别名也认得', () => {
    const aliases = (SDK_SOURCE.match(/\["([a-z_0-9]+)", "[a-z_0-9]+"\]/g) ?? []).map((pair) =>
      pair.slice(2, pair.indexOf('",')),
    )

    expect(aliases.length).toBeGreaterThan(0)

    for (const name of aliases) {
      expect(ompToolView(name, {}, envelope(textBlock('x'))).known).toBe(true)
    }
  })

  it('omp 的别名与 prelude / CustomTool / 设备也认得', () => {
    for (const name of [
      'search',
      'apply_patch',
      'browser',
      'computer',
      'puppeteer',
      'js',
      'python',
      'notebook',
      'fetch',
      'generate_image',
      'tts',
      'vibe_spawn',
      'vibe_send',
      'vibe_wait',
      'vibe_kill',
      'vibe_list',
      'report_issue',
      'report_tool_issue',
      'resolve',
      'reject',
      'propose',
      'hub',
    ]) {
      expect(ompToolView(name, {}, envelope(textBlock('x'))).known).toBe(true)
    }
  })

  /*
   * hub 是 18.2.11 的工具名；18.3.0（我们现在钉的这一版）把它收成了 wait。留着这一档是
   * 为了回放磁盘上 18.2.11 写下的旧会话 —— 那些调用仍然要读出人话。op 有 12 档，且三块
   * 能力（对等消息、后台作业、受管进程）混在一个工具名下面，每档自己说自己在做什么。
   */
  it('hub 逐个 op 说自己的话，不报工具名', () => {
    expect(ompToolView('hub', { op: 'send', to: 'AuthLoader' }, envelope()).headline).toBe(
      '发送消息 AuthLoader',
    )
    expect(ompToolView('hub', { op: 'start', name: 'web' }, envelope()).headline).toBe(
      '启动进程 web',
    )
    expect(ompToolView('hub', { op: 'logs', name: 'web' }, envelope()).headline).toBe(
      '读进程日志 web',
    )
    expect(ompToolView('hub', { op: 'cancel', ids: ['bash_a1'] }, envelope()).headline).toBe(
      '终止作业',
    )
    /* 没见过的 op 也要有话说，不能漏成裸名字。 */
    expect(ompToolView('hub', { op: 'brand_new' }, envelope()).headline).toBe('协调')
  })
})

describe('ompToolView xd:// 设备委派', () => {
  // omp 把可挂载工具收进 write xd://<tool>，真正在跑的是 details.xdev.tool。
  it('write 一次设备调用时按被调的那个工具画', () => {
    const view = ompToolView(
      'write',
      { path: 'xd://lsp', content: '{"action":"diagnostics","file":"a.ts"}' },
      {
        content: [textBlock('a.ts:1:1 [error] boom')],
        details: {
          xdev: {
            tool: 'lsp',
            mode: 'execute',
            args: { action: 'diagnostics', file: 'a.ts' },
            inner: { action: 'diagnostics', success: true, serverName: 'ts' },
          },
        },
      },
    )

    expect(view.kind).toBe('read')
    expect(view.headline).toBe('xd://lsp · 读取诊断 a.ts')
    expect(view.subject).toBe('a.ts')
  })

  it('help 模式不是一次执行，仍按写入画', () => {
    const view = ompToolView(
      'write',
      { path: 'xd://lsp', content: '?' },
      { content: [textBlock('docs')], details: { xdev: { tool: 'lsp', mode: 'help' } } },
    )

    expect(view.kind).toBe('write')
    expect(view.headline).toBe('写入 xd://lsp')
  })

  it('普通写入不受影响', () => {
    const view = ompToolView('write', { path: 'a.ts', content: 'x' }, envelope(textBlock('ok')))

    expect(view.headline).toBe('写入 a.ts')
  })
})

describe('ompToolView 那一行认谁', () => {
  /*
   * omp 每个工具调用都带一句 intent —— 模型自己写的「这次要做什么」（真实录制里是
   * "Reading ADR 0052"、"Checking kap-client drift"）。它比我们按路径/模式拼出来的那句
   * 准，所以默认听它；只有命令与脚本那两档压过它（那一行本来就该是命令本身）。
   * 优先级与 omp 官方那条路一致：modes/acp 的 buildToolTitle。
   */
  it('模型自己写的那句话优先于我们按参数拼出来的', () => {
    const view = ompToolView(
      'read',
      { path: 'docs/adr/0052-omp-is-the-only-agent-via-embedded-sdk.md' },
      envelope(textBlock('...')),
      undefined,
      'Reading ADR 0052',
    )

    expect(view.headline).toBe('Reading ADR 0052')
  })

  it('命令与脚本的那一行仍然是命令本身，概括词盖不过它', () => {
    const bash = ompToolView(
      'bash',
      { command: 'rg -n kap-client' },
      envelope(textBlock('none')),
      undefined,
      'Checking kap-client drift',
    )

    expect(bash.headline).toBe('rg -n kap-client')

    const js = ompToolView(
      'eval',
      { language: 'js', code: 'browser.tabs()' },
      envelope(textBlock('ok')),
      undefined,
      'Listing tabs',
    )

    expect(js.headline).toBe('运行 JavaScript · browser.tabs()')
  })

  it('浏览器那件事仍然压过概括词：prelude 事件就是这一行的事实', () => {
    const view = ompToolView(
      'eval',
      { language: 'js', code: 'await browser.open("https://x")' },
      {
        content: [textBlock('opened')],
        details: { statusEvents: [{ op: 'browser', detail: 'open main https://x' }] },
      },
      undefined,
      'Opening a page',
    )

    expect(view.headline).toBe('浏览器 open main https://x')
  })

  it('没有 intent 的老会话退回按参数算出来的那一句', () => {
    const view = ompToolView('read', { path: 'a.ts' }, envelope(textBlock('x')))

    expect(view.headline).toBe('阅读 a.ts')
  })

  it('空 intent 不算数', () => {
    const view = ompToolView('read', { path: 'a.ts' }, envelope(textBlock('x')), undefined, '')

    expect(view.headline).toBe('阅读 a.ts')
  })
})
