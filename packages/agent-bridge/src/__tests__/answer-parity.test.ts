/*
 * 一条答复的两个半边必须对得上：Rust 序列化出去的那份，正是桥读进来折成
 * 上游 results 的那份。
 *
 * 这条缝是本次改动最容易错的地方 —— 两侧各自单测全绿，接起来却发现字段名不一致
 * （`optionId` vs `option_id`）。所以这里不测「各自的形状」，而是把桥的解析器
 * 喂上 Rust 那份真实输出。
 *
 * 自检跑法：bun test src/__tests__/answer-parity.test.ts
 */

import { expect, test } from 'bun:test'
import { answerPayloadOf, askQuestionsOf } from '../questions.ts'

/*
 * 下面这几份载荷逐字抄自 Rust 的 QuestionResponse 序列化结果
 * （crates/agent-client/src/interaction/question.rs：`tag` + `rename_all = "snake_case"`
 * + `rename_all_fields = "camelCase"`，`method` 另有 snake_case）。
 * Rust 侧的同名测试在 bridge.rs 的 tests 模块里，两侧改一处另一侧就会红。
 */
const RUST_SINGLE = '{"answers":{"q0":{"kind":"single","optionId":"o1"}}}'
const RUST_MULTI = '{"answers":{"q0":{"kind":"multi","optionIds":["o0","o1"]}}}'
const RUST_OTHER = '{"answers":{"q0":{"kind":"other","text":"都不合适"}}}'
const RUST_WITH_OTHER =
  '{"answers":{"q0":{"kind":"multi_with_other","optionIds":["o0"],"otherText":"再加一点"}}}'
const RUST_SKIPPED = '{"answers":{"q0":{"kind":"skipped"}}}'
const RUST_NOTE = '{"answers":{"q0":{"kind":"single","optionId":"o0"}},"note":"整组一句话"}'
const RUST_METHOD = '{"answers":{"q0":{"kind":"single","optionId":"o0"}},"method":"click"}'

const ASKED = askQuestionsOf([
  { id: 'q0', question: '选一个', options: [{ label: '甲' }, { label: '乙' }], multi: false },
])

test('every answer shape Rust can emit is one the bridge can read', () => {
  // 单选的号必须折回标签 —— 上游只认标签。
  expect(answerPayloadOf(ASKED, JSON.parse(RUST_SINGLE))?.results[0]).toMatchObject({
    selectedOptions: ['乙'],
  })
  expect(answerPayloadOf(ASKED, JSON.parse(RUST_MULTI))?.results[0]).toMatchObject({
    selectedOptions: ['甲', '乙'],
  })
  // 自答走 customInput，与勾选可以是同一题的两半。
  expect(answerPayloadOf(ASKED, JSON.parse(RUST_OTHER))?.results[0]).toMatchObject({
    selectedOptions: [],
    customInput: '都不合适',
  })
  expect(answerPayloadOf(ASKED, JSON.parse(RUST_WITH_OTHER))?.results[0]).toMatchObject({
    selectedOptions: ['甲'],
    customInput: '再加一点',
  })
  // 跳过折成空选（上游对单选读成取消，对多选读成「一个都不选」）。
  expect(answerPayloadOf(ASKED, JSON.parse(RUST_SKIPPED))?.results[0]).toMatchObject({
    selectedOptions: [],
  })
  // 备注与作答方式不影响题面，可以同行。
  expect(answerPayloadOf(ASKED, JSON.parse(RUST_NOTE))?.results[0]?.note).toBe('整组一句话')
  expect(answerPayloadOf(ASKED, JSON.parse(RUST_METHOD))?.results[0]?.id).toBe('q0')
})

test('dismissal is the empty answer table, and it means "no answer"', () => {
  /*
   * `QuestionResponse::dismissed()` 就是空表（question.rs）。桥把它读成没答，
   * 上游再读成取消 —— 撤下整组该有的结局。若哪天 Rust 改成别的哨兵，这一条会红。
   */
  expect(answerPayloadOf(ASKED, JSON.parse('{"answers":{}}'))).toBeUndefined()
})

test('an option id the questions never offered is refused, not guessed', () => {
  // 号对不上时宁可当作没答：替人挑一枚就是替他做了决定。
  expect(answerPayloadOf(ASKED, JSON.parse(RUST_SINGLE.replace('"o1"', '"o9"')))).toBeUndefined()
})
