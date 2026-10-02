import { describe, expect, it } from 'bun:test'
import type { AppUpdateState } from '@poietica/update'
import { updateNotice } from './update-phase'

/*
 * 更新这件事只报三句话，而它们**该不该自己走**是这里最容易错的一条：
 *
 * - 下载中与待重启必须常驻 —— 前者的进度淡出等于把人晾着，后者带着唯一的安装入口，
 *   它一走人就没法装了；
 * - 「已是最新」是句回话，说完就该消失；
 * - 下载中每跳一个百分点都重渲，所以它的键必须只认版本，否则横幅会被反复重挂。
 */

const state = (phase: AppUpdateState['phase'], version = '1.2.3'): AppUpdateState =>
  phase === 'ready'
    ? { phase, version }
    : phase === 'downloading'
      ? { phase, version, percent: null }
      : { phase }

describe('更新横幅的文案', () => {
  it('空闲与检查中没有话可说，其余三个相位都上屏', () => {
    expect(updateNotice(state('idle'))).toBeNull()
    expect(updateNotice(state('checking'))).toBeNull()

    expect(updateNotice(state('latest'))).not.toBeNull()
    expect(updateNotice(state('downloading'))).not.toBeNull()
    expect(updateNotice(state('ready'))).not.toBeNull()
  })

  it('下载中与待重启常驻，已是最新说完自己走', () => {
    expect(updateNotice(state('downloading'))?.persistent).toBe(true)
    expect(updateNotice(state('ready'))?.persistent).toBe(true)

    /* 没有未了的事就不该占着屏幕。 */
    expect(updateNotice(state('latest'))?.persistent).toBeUndefined()
  })

  it('只有待重启给动作，且那正是安装入口', () => {
    expect(updateNotice(state('ready'))?.action).toBe('重启安装')

    /* 下载是自动的：给它一颗「下载」按钮等于让人以为不点就不下。 */
    expect(updateNotice(state('downloading'))?.action).toBeUndefined()
    expect(updateNotice(state('latest'))?.action).toBeUndefined()
  })

  it('下载中换百分比不换键，横幅不会跟着重挂', () => {
    const start = updateNotice({ phase: 'downloading', version: '1.2.3', percent: null })
    const midway = updateNotice({ phase: 'downloading', version: '1.2.3', percent: 42 })

    expect(start?.key).toBe(midway?.key)
    /* 换版本才换键：那是另一件事了。 */
    expect(updateNotice({ phase: 'downloading', version: '1.2.4', percent: 42 })?.key).not.toBe(
      midway?.key,
    )
  })

  it('进度写进句子里，用户不必去别处看下到哪了', () => {
    expect(updateNotice({ phase: 'downloading', version: '1.2.3', percent: null })?.text).toContain(
      '1.2.3',
    )
    expect(updateNotice({ phase: 'downloading', version: '1.2.3', percent: 42 })?.text).toContain(
      '42%',
    )
  })

  it('有结论的两条带绿勾，下载中不带', () => {
    expect(updateNotice(state('latest'))?.tone).toBe('success')
    expect(updateNotice(state('ready'))?.tone).toBe('success')
    expect(updateNotice(state('downloading'))?.tone).toBeUndefined()
  })

  it('待重启那句带上版本号', () => {
    expect(updateNotice(state('ready', '1.2.3'))?.text).toContain('1.2.3')
  })

  /*
   * 进度轨只在有确数时画。没有确数还给一个数，屏幕上就是一条从 0% 开始爬的假进度 ——
   * 而「进度未知」本来就是这个端口认的形状（percent: null）。
   */
  it('有确数才给进度轨，未知进度不假装在动', () => {
    expect(updateNotice({ phase: 'downloading', version: '1.2.3', percent: 42 })?.progress).toBe(42)
    expect(
      updateNotice({ phase: 'downloading', version: '1.2.3', percent: null })?.progress,
    ).toBeUndefined()
  })

  /* 0 是一个合法的确数（刚开始），不能因为它是假值就被吞掉。 */
  it('进度 0 也是确数', () => {
    expect(updateNotice({ phase: 'downloading', version: '1.2.3', percent: 0 })?.progress).toBe(0)
  })

  /*
   * 左边那枚字形由 tone 决定：有语气的两档 Banner 自己画绿勾，只有下载中需要调用方给
   * 一枚转着的箭头。这条钉的是「哪一档需要外部字形」，横幅组件按它分支。
   */
  it('只有下载中这一档要调用方带字形', () => {
    expect(updateNotice(state('downloading'))?.tone).toBeUndefined()
    expect(updateNotice(state('ready'))?.tone).toBe('success')
    expect(updateNotice(state('latest'))?.tone).toBe('success')
  })
})
