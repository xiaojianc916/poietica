/*
 * 一个工作目录的身份，以及它的名字。
 *
 * 住在第 0 层，因为它有两个消费者，而它们跨着分层：agent-session（第 2 层）
 * 按它给会话分组，workspace（第 4 层）按它记工作台状态。第 2 层不许依赖第 4 层，
 * 所以这条规则此前只能各写一份 —— agent-session 拿原始路径当 id、自己 split 取
 * 末段；workspace 另有 normalizeRootPath / deriveRepositoryName。同一个概念两套
 * 算法，必然分叉。
 *
 * 身份就是归一化之后的路径本身，不是它的散列：D:\a 与 D:\a\b 是两个平级、
 * 互不隶属的作用域，而一条路径已经是全局唯一的名字了。
 *
 * 归一化只覆盖四件事：分隔符、重复分隔符、结尾分隔符、盘符大小写。NFC、. 与
 * ..、UNC 不在其内 —— 那些属于 src-tauri/src/paths.rs 的职责。
 */

/**
 * 同一个目录的唯一写法。
 *
 * 反斜杠归一成正斜杠、重复分隔符收成一个、去掉结尾的分隔符、盘符大写 ——
 * 这四条都是「同一个目录的两种写法」的来源，而它们必须先消掉，分组才不会把
 * D:\a 和 d:/a/ 算成两个。
 */
export function normalizeWorkspaceRoot(rootPath: string): string {
  const unified = rootPath
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
  const driveCased = unified.replace(
    /^([a-z]):\//,
    (_match, drive: string) => `${drive.toUpperCase()}:/`,
  )
  const trimmed = driveCased.replace(/\/+$/, '')

  return trimmed.length > 0 ? trimmed : '/'
}

/**
 * 人认的那个名字：路径的最后一段。
 *
 * 侧栏那一列窄得放不下一条绝对路径，而项目名足以让人认出来。根没有末段，
 * 那时候路径本身就是它的名字。
 */
export function workspaceRootName(rootPath: string): string {
  const normalized = normalizeWorkspaceRoot(rootPath)
  const lastSlash = normalized.lastIndexOf('/')
  const tail = lastSlash < 0 ? normalized : normalized.slice(lastSlash + 1)

  return tail.length > 0 ? tail : normalized
}

/*
 * 与 apps/desktop/src-tauri/src/paths.rs 的 PROJECTLESS_DIRECTORY 同一条约定。
 *
 * 原生层负责创建目录，这里只识别目录身份。识别的是父目录名加 UUID 子目录，
 * 不是一句显示文案，也不是模型输出。
 */
const PROJECTLESS_DIRECTORY = 'projectless'

const PROJECTLESS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 这个目录是否是 Poietica 为无项目会话创建的内部工作目录。 */
export function isProjectlessWorkspaceRoot(rootPath: string): boolean {
  const normalized = normalizeWorkspaceRoot(rootPath)
  const lastSlash = normalized.lastIndexOf('/')

  if (lastSlash <= 0) {
    return false
  }

  const id = normalized.slice(lastSlash + 1)
  const parent = normalized.slice(0, lastSlash)

  return workspaceRootName(parent) === PROJECTLESS_DIRECTORY && PROJECTLESS_ID.test(id)
}
