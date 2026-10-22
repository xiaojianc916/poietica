import './banner.css'

import { CheckCircle, TriangleAlert } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { Fragment, useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useOverlayRef } from '../overlay-presence'

/*
 * 顶部居中的一句话横幅：滑入、停留、淡出，自己报完就走。
 *
 * 形状照抄 deepseek-harness 的 Toast.tsx / Toast.module.css（行为与时长，别改），但令牌是本
 * 仓的：那边读 --dsw-* 设计平台，这里读 --ui-*。
 *

 * 内核的失败与成功通知也走这里（workbench/parts/banners.tsx）：全应用只有这一个通知落点。

 */

/** 停满不淡的那一段，样式表里 --ui-banner-hold 的回退值必须与它相等。 */
const HOLD_MS = 3000

/** 淡出时长。必须与 banner.css 里 ui-banner-fade 的时长一致。 */
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
   * **null = 不自己走**：没有计时器，也没有淡出，收场由调用方卸载决定。留给「没结束就不该
   * 消失」的事（下载中、等一次点击），不给它一个够长的毫秒数 —— 报一小时只是把同一个错误
   * 推迟一小时。
   */
  readonly holdMs?: number | null
  /**
   * 有确数的进度（0-100）：在卡面下缘画一条进度轨。
   *
   * 与文字里的百分比是同一件事的两种呈现，所以只给数字、不给句子 —— 句子仍由 text 定稿。
   * 不知道进度时不给（不要画一条 0% 的轨假装在动）。
   */
  readonly progress?: number
  /** 淡完时叫一次，调用方在这里卸载它。 */
  readonly onDone: () => void
}

/**
 * 一句话横幅。
 *
 * 走 body 的 portal：调用方若住在一个有 transform 或 filter 的祖先里，固定定位会被那个祖先
 * 的盒子关住。
 *
 * 停留时长由一条自定义属性同时喂给卸载定时器和样式表的淡出延迟，两边因此不会各说各话、把
 * 横幅卸在淡出一半的地方。重渲不会延长寿命：定时器只认 holdMs。
 */
export function Banner({ text, icon, tone, actions, holdMs = HOLD_MS, progress, onDone }: BannerProps) {
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

  const overlayRef = useOverlayRef<HTMLDivElement>('anchored')

  return createPortal(
    <div
      className={holdMs === null ? 'ui-banner ui-banner--sticky' : 'ui-banner'}
      ref={overlayRef}
      role="alert"
      style={
        {
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
        /* 失败同理：红警示是这一档自带的。 */
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
        /* 进度条不接无障碍树：同一件事的文字里已经有确数，这里再报一遍是重复播报。 */
        <span aria-hidden="true" className="ui-banner__progress">
          <span className="ui-banner__progress-fill" style={{ width: `${String(progress)}%` }} />
        </span>
      )}
    </div>,
    document.body,
  )
}
