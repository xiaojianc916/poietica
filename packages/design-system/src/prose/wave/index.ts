/*
 * `@poietica/design-system/wave`：流式文字的批次波浪（切段、排时刻、挂淡入）。
 *
 * 单开子入口而不经 `./prose`：思考行只要节奏与淡入，不该为此把 streamdown / shiki / katex 一串拉进闭包。
 * 回复正文（prose）与思考行（会话时间线的 ticker）都从这里取，「流式的手感」全仓只有这一份。
 */
export { waveFadeIn } from './wave-dom'
export { planWave, WAVE, type WaveOptions, type WavePlan, type WaveSegment, waveSettledAt } from './wave-plan'
