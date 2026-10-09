import './banner.css'

import { CheckCircle, TriangleAlert } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/*
 * 顶部居中的一句话横幅：滑入、停留、淡出，自己报完就走。
 *
 * 版式与动画的正本是 deepseek-harness 的 packages/client/ui-primitives/src/Toast.tsx
 * 与 Toast.module.css（锚定 639ed015）。照抄的是它的行为，不是它的令牌：那边读
 * --dsw-* 设计平台，这里读本仓的 --ui-*，形状与时长一律不动。
 *
 * 一件要说出口、且说得出「怎么办」的事才用它：句子后面接得住动作（撤销、去看看）
 * 才有意义。纯失败通知走 ToastRegion，那是另一件事、另一个落点。
 */

/** 停满不淡的那一段。正本默认值，这里照抄。 */
const HOLD_MS = 3000

/** 淡出时长。必须与 banner.css 里 banner-fade 的时长一致。 */
const FADE_MS = 1000

export interface BannerAction {
  /** 动作前的连词，例如「或」。不给就是紧接正文。 */
  readonly prefix?: string
  readonly label: string
  readonly onClick: () => void
}

export interface BannerProps {
  /** 已经定稿的一句话。文案由调用方给，组件不拼句子。 */
  readonly text: string
  /** 语气。success 自带绿勾、error 自带红警示；不给就自己带 icon。 */
  readonly tone?: 'success' | 'error'
  /** 前面的字形；给了 tone 时不画（那两档的字形才是正主）。 */
  readonly icon?: ReactNode
  /** 接着句子往下说的动作，各自渲染成蓝色可点文字。 */
  readonly actions?: readonly BannerAction[]
  /**
   * 停满多久才开始淡。要读的字多就报长一点。
   *
   * **null = 不自己走**：没有计时器，也没有淡出，收场由调用方卸载决定。留给「没结束就
   * 不该消失」的事（下载中、等一次点击），不给它一个够长的毫秒数 —— 报一小时只是把
   * 同一个错误推迟一小时。
   */
  readonly holdMs?: number | null
  /**
   * 有确数的进度（0-100）：在卡面下缘画一条进度轨。
   *
   * 与文字里的百分比是同一件事的两种呈现，所以只给数字、不给句子 —— 句子仍由 text 定稿。
   * 不知道进度时不给（不要画一条 0% 的轨假装在动）。
   */
  readonly progress?: number
  /** 横幅横向跟谁对齐中心。不给就居中于视口。 */
  readonly anchor?: HTMLElement | null
  /** 淡完时叫一次，调用方在这里卸载它。 */
  readonly onDone: () => void
}

/**
 * 一句话横幅。
 *
 * 走 body 的 portal：调用方若住在一个有 transform 或 filter 的祖先里，固定定位会被
 * 那个祖先的盒子关住。
 *
 * 停留时长由一条自定义属性同时喂给卸载定时器和样式表的淡出延迟，两边因此不会各说
 * 各话、把横幅卸在淡出一半的地方。重渲不会延长寿命：定时器只认 holdMs。
 */
export function Banner({ text, icon, tone, actions, holdMs = HOLD_MS, progress, anchor, onDone }: BannerProps) {
  const latestOnDone = useRef(onDone)

  useLayoutEffect(() => {
    latestOnDone.current = onDone
  }, [onDone])

  useEffect(() => {
    /* 常驻没有计时器：它只由调用方卸载。 */
    if (holdMs === null) {
      return
    }

    const timer = setTimeout(() => {
      latestOnDone.current()
    }, holdMs + FADE_MS)

    return () => {
      clearTimeout(timer)
    }
  }, [holdMs])

  /*
   * 跟着锚点居中时在窗口缩放上重量一次。横幅一共活四秒上下，这段时间里窗口内部的
   * 布局漂移不在射程内。
   */
  const [left, setLeft] = useState<number | null>(null)

  useLayoutEffect(() => {
    if (anchor === null || anchor === undefined) {
      return
    }

    const measure = () => {
      const rect = anchor.getBoundingClientRect()

      setLeft(rect.left + rect.width / 2)
    }

    measure()
    window.addEventListener('resize', measure)

    return () => {
      window.removeEventListener('resize', measure)
    }
  }, [anchor])

  return createPortal(
    <div
      className={holdMs === null ? 'ui-banner ui-banner--sticky' : 'ui-banner'}
      role="alert"
      style={
        {
          ...(left === null ? {} : { left }),
          /* 常驻不设停留时长：样式表那边没有要等的淡出。 */
          ...(holdMs === null ? {} : { '--ui-banner-hold': `${String(holdMs)}ms` }),
        } as CSSProperties
      }
    >
      {tone === 'success' ? (
        /* 绿勾是这一档语气自带的字形，此时调用方给的 icon 不画。 */
        <span aria-hidden="true" className="ui-banner__icon ui-banner__icon--success">
          <CheckCircle />
        </span>
      ) : tone === 'error' ? (
        /* 失败同理：红警示是这一档自带的，与 success 的绿勾同一个位置、同一条规矩。 */
        <span aria-hidden="true" className="ui-banner__icon ui-banner__icon--error">
          <TriangleAlert />
        </span>
      ) : (
        icon !== undefined && (
          <span aria-hidden="true" className="ui-banner__icon">
            {icon}
          </span>
        )
      )}

      <span className="ui-banner__text">
        {text}

        {actions?.map((action) => (
          <Fragment key={action.label}>
            {action.prefix}

            <button className="ui-banner__action" onClick={action.onClick} type="button">
              {action.label}
            </button>
          </Fragment>
        ))}
      </span>

      {progress === undefined ? null : (
        /*
         * 进度条不接无障碍树：同一件事的文字里已经有确数，这里再报一遍是重复播报。
         */
        <span aria-hidden="true" className="ui-banner__progress">
          <span className="ui-banner__progress-fill" style={{ width: `${String(progress)}%` }} />
        </span>
      )}
    </div>,
    document.body,
  )
}
