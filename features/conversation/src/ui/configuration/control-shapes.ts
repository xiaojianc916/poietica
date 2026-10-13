import type { ContextUsage, Controls, Posture } from '@poietica/engine'
import type { SessionConfigControl } from '../agent/config'
import type { SessionGoal } from '../agent/goal'
import type { SessionUsage } from '../agent/usage'
import { GOAL_CONTROL_ID, GOAL_DISABLED, GOAL_ENABLED } from '../components/goal/goal-control'

/** 计划那一档的两个取值（与产品侧 appliesOnSubmit 的选择器同词表）。 */
export const PLAN_CONTROL_ID = 'plan'
export const PLAN_ENABLED = 'on'
export const PLAN_DISABLED = 'off'

/*
 * **只有换算，不做判断**，且刻意独立成模块：ui/index.tsx 与 home-surface.tsx 都要用它，而后者的 `../index` 取法会被 depcruise 判成环（真实违规）。
 */

/**
 * **首帧**那一份可能只是一个还没长出字段的空载荷（宿主 stub、测试桩、Core 刚起来），选择器收到空表只是不画，比整块抛错好。
 */
export const POSTURE_TO_CONTROL: Readonly<Record<Posture, string>> = Object.freeze({
  ask: 'manual',
  'auto-edit': 'yolo',
  'full-access': 'auto',
})

/** 产品侧的那一档 → 引擎的 Posture。认不出就是 undefined（不猜）。 */
export function postureOfControl(value: string): Posture | undefined {
  return (Object.keys(POSTURE_TO_CONTROL) as Posture[]).find((p) => POSTURE_TO_CONTROL[p] === value)
}

export function sessionConfigControlsOf(controls: Controls | null | undefined): readonly SessionConfigControl[] {
  if (controls?.model === undefined || controls?.thinking === undefined) return []
  const model: SessionConfigControl = {
    id: 'model',
    label: '模型',
    purpose: 'model',
    current: controls.model.current === null ? '' : `${controls.model.current.provider}/${controls.model.current.id}`,
    choices: controls.model.choices.map((choice) => ({
      value: `${choice.ref.provider}/${choice.ref.id}`,
      label: choice.label,
    })),
  }
  const thought: SessionConfigControl = {
    id: 'thought',
    label: '思考',
    purpose: 'thought',
    current: controls.thinking.current ?? '',
    choices: controls.thinking.choices.map((choice) => ({ value: choice.id, label: choice.label })),
  }
  /*
   * 这一步换算是必须的：`PermissionPicker` 认的是产品侧那三个值（manual / yolo / auto），把引擎的 ask / auto-edit / full-access 原样交过去，
   * 两组词表交集为空 —— 胶囊与它那张菜单会整颗不画（真实故障：输入框那一排没有批准方式）。
   * 对应关系按 omp 的 approvalMode 对齐：ask → always-ask → manual；auto-edit → write → yolo；full-access → yolo → auto。
   */
  const permission: SessionConfigControl = {
    id: 'permission',
    label: '姿态',
    purpose: 'permission',
    current: POSTURE_TO_CONTROL[controls.posture] ?? 'manual',
    choices: [
      { value: 'manual', label: '请求批准' },
      { value: 'yolo', label: '帮我批准' },
      { value: 'auto', label: '完全访问权限' },
    ],
  }
  /* 计划与目标在 agent 设置里被关掉时**整颗不画** —— 画一个点了会报错的按钮比不画更糟。`available` 缺省按不可用处置。 */
  const controlsOut: SessionConfigControl[] = [model, thought, permission]
  if (controls.available?.plan === true) {
    controlsOut.push({
      id: PLAN_CONTROL_ID,
      label: '计划',
      purpose: 'mode',
      current: controls.planMode ? PLAN_ENABLED : PLAN_DISABLED,
      choices: [
        { value: PLAN_DISABLED, label: '直接执行', detail: '不先出计划，直接动手' },
        { value: PLAN_ENABLED, label: '计划', detail: '先只读探查并给出计划，批准后再动手' },
      ],
    })
  }
  if (controls.available?.goal === true) {
    controlsOut.push({
      id: GOAL_CONTROL_ID,
      label: '目标',
      purpose: 'mode',
      /* 开目标要有正文当 objective，而正文是用户下一句要打的话：面板把「目标」画成待提交，收工由发送那一步一起交。 */
      appliesOnSubmit: true,
      current: controls.goal === null ? GOAL_DISABLED : GOAL_ENABLED,
      choices: [
        { value: GOAL_DISABLED, label: '不收目标', detail: '按普通一轮对话处理' },
        { value: GOAL_ENABLED, label: '目标', detail: '把它当作一个持续目标，达成前不中断' },
      ],
    })
  }
  return controlsOut
}

/**
 * 引擎那一格带**构成明细**（五类占用 + 空闲 + 自动压缩缓冲），原样透传给胶囊：面板那七行与条上的分段都按它画。引擎报 null 时退成只画总条。
 * `inputOther / inputCacheRead / inputCacheCreation` 留 0：那三格是**累计**输入口径，与上下文占用不是一回事，引擎端口没有对应报数，如实留空、不编假值。
 */
export function sessionUsageOf(context: ContextUsage | null | undefined): SessionUsage | undefined {
  if (context === null || context === undefined) return undefined
  return {
    used: context.usedTokens,
    size: context.windowTokens,
    inputOther: 0,
    inputCacheRead: 0,
    inputCacheCreation: 0,
    breakdown: context.breakdown,
  }
}

/**
 * 没有目标（null / 老载荷缺这一格）返回 undefined，面板整条不画。`receivedAt` 取**此刻**：秒针是「快照到手之后的本地时间」，补零得当场盖，不然面板一上手就报一个假的用时。
 */
export function sessionGoalOf(snapshot: Controls['goalSnapshot'], receivedAt: number): SessionGoal | undefined {
  if (snapshot === null || snapshot === undefined) return undefined
  return {
    objective: snapshot.objective,
    completionCriterion: snapshot.completionCriterion,
    status: snapshot.status,
    turnsUsed: snapshot.turnsUsed,
    tokensUsed: snapshot.tokensUsed,
    wallClockMs: snapshot.wallClockMs,
    receivedAt,
  }
}

/**
 * **两条来源，一条优先：** `controls.contextChanged` 压过 `controls.get` 带回来的初值。判据是 `undefined` 与 `null` 分得开：
 * `undefined` = 从没收到过推送 → 用控件表里那份初值；`null` = **收到过**一次「此刻没有可报的窗口」→ 就是没有，不回退（回退会让换到无窗口模型之后又冒出旧数字）。
 */
export function effectiveUsage(
  pushed: ContextUsage | null | undefined,
  initial: { readonly context: ContextUsage | null } | null,
): SessionUsage | undefined {
  return sessionUsageOf(pushed === undefined ? initial?.context : pushed)
}
