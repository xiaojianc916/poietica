import { normalizeWorkspaceRoot } from '@poietica/conversation'
import { createPreference } from '@poietica/external-store'
import { homeDirectory } from '@poietica/native-bridge'
import { warn } from '@poietica/problem'
import { useSyncExternalStore } from 'react'

/*
 * 当前的工作目录 —— 整个进程唯一的答案。
 *
 * 它是 agent 的作用域：会话在这个目录里开，对话按这个目录分组，工作台状态按
 * 这个目录分域。
 *
 * 走 createPreference 而不是 @poietica/settings：那条管线是异步的，第一帧读不到
 * 值 —— 而这一格决定第一次 open 打在哪个目录里，它必须在第一帧就有答案。
 *
 * 缺席是有含义的，不是错误状态：还没有选过目录。那时候分组落在
 * DEFAULT_WORKSPACE_ID 上、界面不画组头（见 packages/agent/src/session/thread-order.ts 的 workspaceNameOf）。
 */

const ACTIVE_FAILURE = {
  read: '读不出工作目录偏好',
  write: '写不进工作目录偏好',
}

const active = createPreference<string | null>({
  key: 'poietica.workspace.activeRoot',
  fallback: null,
  decode: (raw) => (raw.length > 0 ? normalizeWorkspaceRoot(raw) : null),
  encode: (value) => value,
  onFailure: ({ stage, cause }) => {
    warn(ACTIVE_FAILURE[stage], { scope: 'workspace-root', cause })
  },
})

/**
 * 此刻的工作目录，还没有选过就是 null。
 *
 * 模块函数，引用终生不变，所以它可以直接当那个「一次求值」交给 IPC 的桥。
 */
export function activeWorkspaceRoot(): string | null {
  return active.read()
}

/** 换一个工作目录。归一化只发生在这一处入口。 */
export function setActiveWorkspaceRoot(rootPath: string | null): void {
  const next = rootPath === null || rootPath.length === 0 ? null : normalizeWorkspaceRoot(rootPath)

  active.write(next)
}

/** 订阅它。 */
export function useActiveWorkspaceRoot(): string | null {
  return useSyncExternalStore(active.subscribe, active.read, active.readFallback)
}

/*
 * 用户主目录 —— 没有记下目录的那些对话所在的工作区。
 *
 * 这是一个 OS 事实，不是一句文案：@poietica/native-bridge 的 homeDirectory()
 * 转发官方能力回答它，不手写 %USERPROFILE% / $HOME 猜测 —— 各自的边界情况是
 * 平台已经解决的问题。非 Tauri 宿主里答案是 null，分组落回无名哨兵。
 *
 * 与上面的 activeRoot 同一条管线：一次解析，进程里一个答案，落盘让第二次启动
 * 的第一帧就有值；首次解析落定后由 ThreadsProvider 等它再 refresh，不会先把
 * 存量落进哨兵组再跳一次。
 */

const HOME_FAILURE = {
  read: '读不出主目录偏好',
  write: '写不进主目录偏好',
}

const home = createPreference<string | null>({
  key: 'poietica.workspace.homeRoot',
  fallback: null,
  decode: (raw) => (raw.length > 0 ? normalizeWorkspaceRoot(raw) : null),
  encode: (value) => value,
  onFailure: ({ stage, cause }) => {
    warn(HOME_FAILURE[stage], { scope: 'workspace-root', cause })
  },
})

const resolving: Promise<string | null> = homeDirectory()
  .then((dir) => {
    home.write(normalizeWorkspaceRoot(dir))

    return home.read()
  })
  .catch(() => null)

/** 没有记下目录的对话落在哪个工作区；还没解析出来时落 thread-order 的哨兵。 */
export function defaultWorkspaceId(): string | null {
  return home.read()
}

/** 主目录解析落定的那一刻。第一次启动的第一次列表读取等它。 */
export function defaultWorkspaceReady(): Promise<unknown> {
  return resolving
}
