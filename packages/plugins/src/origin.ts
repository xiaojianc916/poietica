import { assertUnreachable } from '@poietica/core'

/*
 * 一项能力是谁带来的。
 *
 * 插件不是技能，也不是 MCP 服务器 —— 它是把它们打包分发的那个单元。Kimi 官方文档
 * 把这三样分在三处说：MCP 服务器写在 mcp.json 里，技能放在 skills/ 下，而插件
 * 「也可以」在清单里声明 MCP 服务器。插件是来源之一，不是这两样的定义。
 *
 * 所以这一位是联合而不是一个插件号。写成 pluginId: string 就等于在类型上断言「每一条
 * 能力必然属于某个插件」，而这句话是假的：mcp.json 里那些无处安放。删掉其中任何一支，
 * 编译器会在全部引用点报错 —— 那正是它该有的行为。
 */

export interface PluginOrigin {
  readonly kind: 'plugin'
  readonly pluginId: string
}

/**
 * 装在这个 agent 自己家里的：不经插件，由人或它自己的 CLI 写进去。
 *
 * 「自己家」的判据只有一条 —— 这个 agent 起进程时会去读的那个目录。受控 home 生效
 * 时它在数据根之下，不受控时在用户 home 里，两者都由原生侧算。别家客户端的配置文件
 * 不属于这一档：它们是真实存在的位置，但这个 agent 不读，列出来就是一排拨了不生效
 * 的开关。
 */
export interface UserOrigin {
  readonly kind: 'user'
  /** 落在哪个文件里。界面要显示它，排障也只能靠它。 */
  readonly location: string
}

/* 两种来源本应用都拨得动，所以「谁带来的」与「拨得动哪些」是同一个集合，不写成两个名字。 */
export type ContributionOrigin = PluginOrigin | UserOrigin

/** 列表右边那个标签。 */
export function describeOrigin(origin: ContributionOrigin): string {
  switch (origin.kind) {
    case 'plugin':
      return origin.pluginId
    case 'user':
      return '个人'
    default:
      return assertUnreachable(origin)
  }
}
