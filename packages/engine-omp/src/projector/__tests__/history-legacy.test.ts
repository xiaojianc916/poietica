import { describe, expect, test } from 'bun:test'
import { type OmpMessage, projectHistoryPage } from '../history'
import { assistant, assistantTexts, prompts, T0, toolCall, toolResult, user } from './fixtures/history'

/*
 * 迁移自 legacy transcript-mirror.test.ts（12 页 §12.3：原来针对镜像窗口的用例，改为针对历史分页）。
 *
 * legacy 的镜像机制在 12 页 §9.2 里已被删除：分页不再从 Core 保存的第二份正文算，
 * 而是直接从 omp 的会话消息算。契约里仍然成立的那几条在这里逐条钉：
 * 「没更早的了要如实说」「认不出的游标回空页而不是原地不动」「开窗只取最近几轮」
 * 「翻页必须严格更早」「附件不带没被引用的」。
 */
describe('历史分页（legacy transcript-mirror.test.ts 的窗口语义）', () => {
  test('手上就是全部时如实说没有更早的', () => {
    const page = projectHistoryPage([user('hi', 0)], null)
    expect(page.items).toHaveLength(1)
    expect(page.hasMoreOlder).toBe(false)
  })

  test('没被碰过的会话给一页合法的空页', () => {
    const page = projectHistoryPage([], null)
    expect(page.items).toEqual([])
    expect(page.attachments).toEqual([])
    expect(page.hasMoreOlder).toBe(false)
  })

  test('窗口开在最新那几轮上：最新一轮一定在，并如实说还有更早的', () => {
    const messages = [
      user('一', 0),
      assistant('a', 1),
      user('二', 10),
      assistant('b', 11),
      user('三', 20),
      assistant('c', 21),
      user('四', 30),
      assistant('d', 31),
    ]
    const page = projectHistoryPage(messages, null, { pageSize: 2 })
    // 屏幕先画眼下，更早的再翻
    expect(prompts(page)).toEqual(['三', '四'])
    expect(page.hasMoreOlder).toBe(true)
  })

  test('翻页回到的轮严格更早，且到最老那一页就停', () => {
    const messages = [
      user('一', 0),
      assistant('a', 1),
      user('二', 10),
      assistant('b', 11),
      user('三', 20),
      assistant('c', 21),
    ]
    const first = projectHistoryPage(messages, null, { pageSize: 2 })
    const oldest = first.items.find((item) => item.kind === 'turn')
    expect(oldest?.kind === 'turn' && oldest.ordinal).toBe(2)

    const earlier = projectHistoryPage(messages, 't2', { pageSize: 2 })
    expect(prompts(earlier)).toEqual(['一'])
    for (const item of earlier.items) {
      if (item.kind === 'turn') expect(item.ordinal).toBeLessThan(2)
    }
    // 翻到最老那一页：不能再往回翻（不是原地不动，也不是死循环）
    expect(earlier.hasMoreOlder).toBe(false)
  })

  test('认不出的游标给空页，而不是原地不动的非空页', () => {
    const page = projectHistoryPage([user('一', 0), assistant('a', 1)], 'nope')
    expect(page.items).toEqual([])
    expect(page.hasMoreOlder).toBe(false)
  })

  test('只带上开出来的那几轮引用的附件（没被引用的不入页）', () => {
    const messages = [
      {
        role: 'user',
        timestamp: T0,
        content: [
          { type: 'text', text: '第一轮带图' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
      },
      assistant('看到了', 10),
      user('第二轮', 20),
      assistant('答', 30),
    ]
    // 最新那一页只开第二轮：第一轮那张图不在页里
    const newest = projectHistoryPage(messages, null, { pageSize: 1 })
    expect(prompts(newest)).toEqual(['第二轮'])
    expect(newest.attachments).toEqual([])

    // 翻回第一轮：图跟着它一起来
    const older = projectHistoryPage(messages, 't2')
    expect(prompts(older)).toEqual(['第一轮带图'])
    expect(older.attachments).toHaveLength(1)
    expect(older.attachments[0]?.mediaType).toBe('image/png')
  })
})

/*
 * 历史里的图片（legacy history-images.test.ts）。
 *
 * 缘起是一个真实的缺口：omp 读会话文件时已把 blob 引用换回 base64 内联进消息正文，
 * 而投影只取文本块、图片块整块丢掉 —— 重开一条带图的会话，图全都不见了。像素就在手上，
 * 缺的只是把它交出去。判据是 url 源且带得出像素：界面按这一格直接画。
 */
describe('历史里的图片（legacy history-images.test.ts）', () => {
  test('图片块变成一条能画的附件，裸 base64 拼成 data URL 而不是原样交出去', () => {
    const page = projectHistoryPage(
      [
        {
          role: 'user',
          timestamp: T0,
          content: [
            { type: 'text', text: '看图' },
            { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          ],
        },
        assistant('看到了', 10),
      ],
      null,
    )
    expect(page.attachments).toHaveLength(1)
    expect(page.attachments[0]).toMatchObject({
      mediaType: 'image/png',
      source: { kind: 'url', url: 'data:image/png;base64,AAAA' },
    })
    // 号里带上这条消息的时刻：两条各带一张图的用户消息不能撞号（撞了后一张会盖掉前一张）
    const second = projectHistoryPage(
      [
        {
          role: 'user',
          timestamp: T0,
          content: [{ type: 'image', data: 'BBBB', mimeType: 'image/jpeg' }],
        },
        {
          role: 'user',
          timestamp: T0 + 5000,
          content: [{ type: 'image', data: 'CCCC', mimeType: 'image/png' }],
        },
      ],
      null,
    )
    const ids = second.attachments.map((attachment) => attachment.attachmentId)
    expect(new Set(ids).size).toBe(2)
  })

  test('已经是 data URL 的原样带上，不叠一层前缀', () => {
    const page = projectHistoryPage(
      [
        {
          role: 'user',
          timestamp: T0,
          content: [{ type: 'image', data: 'data:image/webp;base64:DDDD', mimeType: 'image/webp' }],
        },
      ],
      null,
    )
    expect(page.attachments[0]?.source).toEqual({
      kind: 'url',
      url: 'data:image/webp;base64:DDDD',
    })
  })

  test('块没声明内容类型时按 png 兜底；空数据的图片块不是一张图', () => {
    const withDefault = projectHistoryPage(
      [{ role: 'user', timestamp: T0, content: [{ type: 'image', data: 'EEEE' }] }],
      null,
    )
    expect(withDefault.attachments[0]?.mediaType).toBe('image/png')

    const empty = projectHistoryPage(
      [{ role: 'user', timestamp: T0, content: [{ type: 'image', data: '', mimeType: 'image/png' }] }],
      null,
    )
    expect(empty.attachments).toEqual([])
  })

  test('图片块不占正文帧：同一格里的文字照常上屏', () => {
    const page = projectHistoryPage(
      [
        {
          role: 'user',
          timestamp: T0,
          content: [
            { type: 'text', text: '看图' },
            { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          ],
        },
        assistant('看到了', 10),
      ],
      null,
    )
    expect(prompts(page)).toEqual(['看图'])
    expect(assistantTexts(page)).toEqual(['看到了'])
  })
})

/*
 * 技能轮（legacy skill-turn.test.ts）。
 *
 * 技能以 role: 'custom' + customType: 'skill-prompt' + attribution: 'user' 进显示经过
 * （判据就是官方 pi-tui 的 isUserTurnInitiator 那一条）。两条事实都静默坏过：
 * chip 在重投影之后还在（origin.payload.skillActivations），以及 SKILL.md 的整份正文不上屏。
 */
describe('技能轮（legacy skill-turn.test.ts）', () => {
  const SKILL_BODY = '[IMPORTANT: User invoked the "ponytail" skill; follow its instructions. Full skill below.]'
  const skillMessage = (attribution?: string): OmpMessage => ({
    role: 'custom',
    customType: 'skill-prompt',
    ...(attribution === undefined ? {} : { attribution }),
    display: true,
    content: [{ type: 'text', text: SKILL_BODY }],
    details: { name: 'ponytail', path: 'C:/skills/ponytail/SKILL.md', args: '清理冗余代码', prompt: '清理冗余代码' },
    timestamp: T0,
  })

  test('技能那一轮带着 chip（origin.payload.skillActivations），人的原话落回 prompt', () => {
    const page = projectHistoryPage([skillMessage('user'), assistant('做完了', 10)], null)
    const turn = page.items[0]
    expect(turn?.kind === 'turn' && turn.origin).toMatchObject({
      kind: 'user',
      payload: { kind: 'skill_activation', trigger: 'user-slash', skillActivations: [{ skillName: 'ponytail' }] },
    })
    expect(prompts(page)).toEqual(['清理冗余代码'])
  })

  test('SKILL.md 的整份正文不上屏，助手那一趟照常画', () => {
    const page = projectHistoryPage([skillMessage('user'), assistant('做完了', 10)], null)
    expect(assistantTexts(page)).toEqual(['做完了'])
    for (const text of assistantTexts(page)) expect(text).not.toContain('User invoked the')
  })

  test('没有 attribution 的技能消息不算「人自己发起的技能轮」，不编 chip', () => {
    const page = projectHistoryPage([skillMessage(), assistant('做完了', 10)], null)
    const turn = page.items[0]
    expect(turn?.kind === 'turn' && turn.origin).toEqual({ kind: 'user' })
  })
})

/*
 * 压缩（legacy compaction-events.test.ts）。
 *
 * 缘由：上下文被压缩时屏幕上什么都不说，人看到的是自己前几句莫名其妙没了。
 * history 这一侧把压缩摘要铺成一行 marker；号按轮走，两次压缩各占一行。
 * legacy 的 tokensBefore / cancelled 那两档由 live 的开门关门事件产出，新树里那一侧没有生产者
 * （12 页 §9.1 的表与 §7.8 的实现不一致），所以这里只钉历史真正带得出来的那几格。
 */
describe('压缩标记（legacy compaction-events.test.ts）', () => {
  test('压缩那一条铺成一行 marker，号按轮走', () => {
    const page = projectHistoryPage(
      [{ role: 'compactionSummary', timestamp: T0, summary: '压好了' }, user('问题', 10), assistant('答', 20)],
      null,
    )
    const markers = page.items.filter((item) => item.kind === 'marker')
    expect(markers).toHaveLength(1)
    expect(markers[0]).toMatchObject({ marker: 'compaction', markerId: 'compaction-1' })
    // 压缩摘要占的是「一轮」的位置：它后面那句人话另起一轮，不被吞掉
    expect(prompts(page)).toEqual(['问题'])
  })

  test('第二次压缩另起一行，两次压缩不是一行', () => {
    const page = projectHistoryPage(
      [
        { role: 'compactionSummary', timestamp: T0, summary: '第一次' },
        user('问题', 10),
        assistant('答', 20),
        { role: 'compactionSummary', timestamp: T0 + 30, summary: '第二次' },
        user('又问', 40),
        assistant('再答', 50),
      ],
      null,
    )
    const markers = page.items.filter((item) => item.kind === 'marker')
    expect(markers.map((marker) => marker.markerId)).toEqual(['compaction-1', 'compaction-3'])
    expect(markers.map((marker) => marker.payload)).toMatchObject([
      { state: 'completed', summary: '第一次' },
      { state: 'completed', summary: '第二次' },
    ])
  })

  test('agent 没给的数字不编：payload 里没有 tokensAfter，也就没有凭空报 0', () => {
    const page = projectHistoryPage([{ role: 'compactionSummary', timestamp: T0, summary: '压好了' }], null)
    const marker = page.items.find((item) => item.kind === 'marker')
    expect(marker?.kind === 'marker' && marker.payload).not.toHaveProperty('tokensBefore')
    expect(marker?.kind === 'marker' && marker.payload).not.toHaveProperty('tokensAfter')
  })

  test('摘要缺席时不编一句空摘要', () => {
    const page = projectHistoryPage([{ role: 'compactionSummary', timestamp: T0 }], null)
    const marker = page.items.find((item) => item.kind === 'marker')
    expect(marker?.kind === 'marker' && marker.payload).not.toHaveProperty('summary')
    expect(marker?.kind === 'marker' && marker.payload).toMatchObject({ state: 'completed' })
  })
})

/*
 * 插话在历史里的形态（legacy interjection-layers.test.ts 的那条主线）。
 *
 * legacy 那一侧靠一个「认领账本」把已经注入的插话画成一句人话；新树删掉了账本
 * （12 页 §9.2：分页直接从 omp 的会话消息算，Core 不保存第二份正文），
 * 所以历史这条路的判据变成：人说过的话一定开一轮、一定看得到，
 * 而 steer / followUp 折进上下文之后与普通提交没有分别。
 */
describe('插话在历史里的形态（legacy interjection-layers.test.ts）', () => {
  test('折进上下文的插话是一句人话，自己开一轮', () => {
    const page = projectHistoryPage([user('第一轮', 0), assistant('答', 10), user('一句followUp', 20)], null)
    // 历史这一路不摆第二份正文：人说的话在 turn.prompt 上（与 UI 同一个读法），
    // 而「画成一句人话」那一格由实时那条路的 steeredFrame 出（见 interjection.test.ts）
    expect(prompts(page)).toEqual(['第一轮', '一句followUp'])
    const last = page.items.at(-1)
    expect(last?.kind === 'turn' && last.origin).toMatchObject({ kind: 'user' })
    expect(last?.kind === 'turn' && last.ordinal).toBe(2)
  })

  test('一轮从人话开始到下一句人话为止：模型跑几趟也只是一轮', () => {
    const page = projectHistoryPage(
      [
        user('问题', 0),
        assistant('先看看', 10),
        toolCall('c1', 'read', { path: 'a.ts' }, 20),
        toolResult('c1', '文件内容'),
        assistant('答案是 42', 30),
      ],
      null,
    )
    expect(page.items.filter((item) => item.kind === 'turn')).toHaveLength(1)
  })
})

describe('一页的代表性形状（12 页 §9.5 的快照）', () => {
  test('两轮：带图的第一轮 + 带工具的第二轮，整页快照一次看全', () => {
    const page = projectHistoryPage(
      [
        {
          role: 'user',
          timestamp: T0,
          content: [
            { type: 'text', text: '看图' },
            { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          ],
        },
        assistant('看到了', 10),
        user('跑一下', 20),
        toolCall('c1', 'bash', { command: 'npm test' }, 30),
        toolResult('c1', [{ type: 'text', text: '全绿' }]),
        assistant('做完了', 40),
      ],
      null,
    )
    expect(page).toMatchSnapshot()
  })
})
