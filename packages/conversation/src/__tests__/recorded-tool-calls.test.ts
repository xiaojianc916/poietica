import { describe, expect, it } from 'bun:test'
import { ompToolView } from '../transcript/omp-tool-view'

/*
 * 真实录制回放。
 *
 * 下面这些是**从本机 omp 会话日志里抄下来的原样条目**
 * （%LOCALAPPDATA%/com.poietica.Poietica.dev/agents/omp/home/sessions/**\/*.jsonl 的
 * `tool_execution_start` 与随后的 `message.role === "toolResult"`）。
 *
 * 这一条与其余用例不同：其余用例是照着我理解的形状写的，这一条是照**真的送来的那一份**
 * 写的。形状对不上时它会失败，而不是让我自己写的夹具一直通过。
 */
describe('真实录制里的工具调用', () => {
  it('read 一个目录：路径进主语，列表进产出', () => {
    // tool_execution_start: {"toolName":"read","args":{"path":"D:/xiaojianc/poietica"},"intent":"Listing workspace root"}
    const view = ompToolView(
      'read',
      { path: 'D:/xiaojianc/poietica' },
      {
        content: [{ type: 'text', text: '.\n  - .gitignore   2.5KB   7h ago\n  - tmp/' }],
      },
      undefined,
      'Listing workspace root',
    )

    expect(view.known).toBe(true)
    expect(view.kind).toBe('read')
    expect(view.subject).toBe('D:/xiaojianc/poietica')
    expect(view.headline).toBe('Listing workspace root')
    expect(view.shape).toBe('result')
    expect(view.response[0]?.type).toBe('command')
  })

  it('glob 的模式住在 path 字段里', () => {
    const view = ompToolView(
      'glob',
      { path: '**/*.md' },
      { content: [{ type: 'text', text: 'package.json\nbun.lock\n# docs/\nREADME.md' }] },
      undefined,
      'Finding top-level project docs',
    )

    expect(view.subject).toBe('**/*.md')
    expect(view.headline).toBe('Finding top-level project docs')
  })

  it('带行号选择器的 read 仍然认得出扩展名', () => {
    // arguments: {"path":"D:/xiaojianc/poietica/AGENTS.md:1-120"}
    const view = ompToolView(
      'read',
      { path: 'D:/xiaojianc/poietica/AGENTS.md:1-120' },
      { content: [{ type: 'text', text: '# Poietica 架构宪法' }] },
      undefined,
      'Reading AGENTS conventions',
    )

    expect(view.response[0]?.type === 'command' && view.response[0].language).toBe('markdown')
    expect(view.headline).toBe('Reading AGENTS conventions')
  })

  it('bash：那一行是命令本身，退出码落在产出那面', () => {
    const view = ompToolView(
      'bash',
      { command: 'rg -c kap-client || echo absent' },
      { content: [{ type: 'text', text: 'absent' }], details: { exitCode: 0 } },
      undefined,
      'Confirming kap-client absent, counting stale refs',
    )

    expect(view.headline).toBe('rg -c kap-client || echo absent')
    expect(view.shape).toBe('flow')
    expect(view.request[0]?.type).toBe('command')
  })

  it('grep：模式进主语', () => {
    const view = ompToolView(
      'grep',
      { pattern: 'kap-client' },
      { content: [{ type: 'text', text: 'crates/agent-client/src/frame.rs:41' }] },
      undefined,
      'Checking kap-client drift',
    )

    expect(view.subject).toBe('kap-client')
    expect(view.headline).toBe('Checking kap-client drift')
  })

  it('同一次 assistant 消息里的多个 toolCall 各自独立', () => {
    // 真实的一轮里 read 与 glob 是同一批发出的两条，各按自己的工具画。
    const calls = [
      ompToolView(
        'read',
        { path: 'D:/x' },
        { content: [{ type: 'text', text: 'a' }] },
        undefined,
        'Listing workspace root',
      ),
      ompToolView(
        'glob',
        { path: '*.md' },
        { content: [{ type: 'text', text: 'b' }] },
        undefined,
        'Finding top-level project docs',
      ),
    ]

    expect(calls.map((view) => view.kind)).toEqual(['read', 'search'])
    expect(calls.map((view) => view.headline)).toEqual([
      'Listing workspace root',
      'Finding top-level project docs',
    ])
  })
})
