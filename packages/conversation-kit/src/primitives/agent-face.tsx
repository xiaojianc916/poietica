import './agent-face.css'

import { cn } from '@poietica/design-system'
import { type CSSProperties, memo, useEffect, useRef } from 'react'
import { type AgentFaceStatus, BASE_EXPRESSION, faceState, startFaceMotion } from './agent-face-motion'

/*
 * 瓦片脸（照 ZCode 的 WorkflowAgentFace，zai-org/ZCode @ fec9759）：20×20 的圆角方块 + 两只眼。
 * 身份是机身色：九个固定色按 avatarIndex 取、第十个起循环；没有编号时退回名字散列。
 * 状态只改表情，机身始终静止；动效在 agent-face-motion 里，按帧不进 React。
 */

/** 身份色板。九个固定 HEX 与 ZCode 逐格同值（那里是 FACE_COLORS，两种主题同色）。 */
export const AGENT_FACE_COLORS = [
  '#54B9A6',
  '#F19D38',
  '#6464EF',
  '#885CF5',
  '#3C82F6',
  '#ED712E',
  '#EB4699',
  '#5BC67A',
  '#EA4045',
] as const

/** 名字散列选色（31 进制取模 360 后映射到九色板）；只在没有 avatarIndex 时兜底。 */
export function agentFaceColor(name: string): string {
  let hash = 0
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360
  return AGENT_FACE_COLORS[hash % AGENT_FACE_COLORS.length] ?? AGENT_FACE_COLORS[0]
}

/** 编号优先（九色环循环），缺席时退回名字散列 —— 同名同色，同一次派发的行与标签同色。 */
export function agentColor(avatarIndex: number | undefined, name: string): string {
  if (avatarIndex === undefined) return agentFaceColor(name)
  const ring = AGENT_FACE_COLORS.length
  return AGENT_FACE_COLORS[((avatarIndex % ring) + ring) % ring] ?? AGENT_FACE_COLORS[0]
}

const EXPRESSIONS = ['pill', 'happy', 'sleepy', 'focused', 'sad', 'confused'] as const

/** 睁眼那几笔的路径：四种斜切眼共用一个字形表，两眼的左右镜像写在表里。 */
const LID_PATHS: Readonly<Record<string, readonly [string, string]>> = {
  happy: ['M0 11 V8 A2 2 0 0 1 4 8 V11 Z', 'M0 11 V8 A2 2 0 0 1 4 8 V11 Z'],
  sleepy: ['M0 8 L4 7 V9 A2 2 0 0 1 0 9 Z', 'M0 7 L4 8 V9 A2 2 0 0 1 0 9 Z'],
  focused: ['M0 6 L4 8 V10 A2 2 0 0 1 0 10 Z', 'M0 8 L4 6 V10 A2 2 0 0 1 0 10 Z'],
  sad: ['M0 8 L4 6 V10 A2 2 0 0 1 0 10 Z', 'M0 6 L4 8 V10 A2 2 0 0 1 0 10 Z'],
}

/** 一只眼：胶囊那一档是两块圆角短条（困惑那只略短），其余按 LID_PATHS 的路径。 */
function Eye({ expression, x }: { readonly expression: string; readonly x: number }) {
  if (expression === 'pill' || expression === 'confused') {
    const short = expression === 'confused' && x === 13
    return <rect height={short ? 4 : 6} rx={2} width={4} x={x} y={short ? 8 : 6} />
  }
  const pair = LID_PATHS[expression]
  const d = pair?.[x === 7 ? 0 : 1] ?? ''
  return <path d={d} transform={`translate(${String(x)} 0)`} />
}

/** 直接在 20 格内绘制参考眼型；共享左右起点，换脸时保持底部和视线位置。 */
function Eyes() {
  return (
    <g className="agent-face__eyes">
      <g className="agent-face__bounce">
        <g className="agent-face__lids">
          <g data-eye-expression="dots" fill="var(--agent-face-eye)">
            {[5, 10, 15].map((cx) => (
              <circle cx={cx} cy={10} key={cx} r={1.5} />
            ))}
          </g>
          {EXPRESSIONS.map((expression) => (
            <g data-eye-expression={expression} fill="var(--agent-face-eye)" key={expression}>
              {[7, 13].map((x) => (
                <Eye expression={expression} key={x} x={x} />
              ))}
            </g>
          ))}
        </g>
        {/* 闭眼单独画横胶囊，避免纵向缩放把端部圆角压成细线。 */}
        <g className="agent-face__closed" fill="var(--agent-face-eye)">
          {[7, 13].map((x) => (
            <rect height={2} key={x} rx={1} width={4} x={x} y={8} />
          ))}
        </g>
      </g>
    </g>
  )
}

export interface AgentFaceProps {
  readonly avatarIndex?: number | undefined
  readonly className?: string | undefined
  readonly name: string
  /** 缺席 = 还没报出状态（脸停在等待那一档）。 */
  readonly status: AgentFaceStatus | undefined
  /** 设置页那种纯装饰的脸：只眨眼巡视，不借执行状态。 */
  readonly idle?: boolean
  /** 完成时在左下角外叠一枚勾。 */
  readonly showCompletionMark?: boolean
  /** 显式机身色；不传则按 avatarIndex / 名字取身份色。 */
  readonly color?: string
}

export const AgentFace = memo(function AgentFace({
  avatarIndex,
  className,
  color,
  idle = false,
  name,
  showCompletionMark = false,
  status,
}: AgentFaceProps) {
  const ref = useRef<SVGSVGElement>(null)
  const state = idle ? 'idle' : faceState(status)
  useEffect(() => {
    if (ref.current === null || showCompletionMark) {
      return undefined
    }
    return startFaceMotion(ref.current, state)
  }, [state, showCompletionMark])
  const style = { '--agent-face-body': color ?? agentColor(avatarIndex, name) } as CSSProperties

  return (
    <svg
      aria-hidden="true"
      className={cn('agent-face overflow-visible', className)}
      data-expression={BASE_EXPRESSION[state]}
      data-face-state={state}
      data-motion="idle"
      data-subagent-avatar=""
      ref={ref}
      style={style}
      viewBox="0 0 20 20"
    >
      <rect className="agent-face__body" fill="var(--agent-face-body)" height={20} rx={7} width={20} />
      <Eyes />
      {showCompletionMark ? (
        /* 完成徽标向左下角外叠；折叠容器要给它留绘制空间，不移动头像也不遮眼睛。 */
        <g data-subagent-completion-badge="">
          <circle cx={3} cy={17} fill="var(--ui-success)" r={5.5} stroke="var(--cp-ground)" strokeWidth={1.5} />
          <path
            d="m0.5 17 1.7 1.7 3.3-3.4"
            fill="none"
            stroke="var(--ui-success-foreground)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
          />
        </g>
      ) : null}
    </svg>
  )
})
