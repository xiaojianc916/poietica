import type { Root } from 'hast'

/*
 * 给正文的每个段落标出语言。
 *
 * 根元素是 zh-CN，所有段落都继承它；但模型回答里常有整段英文、公式说明或代码清单。
 * 两端对齐只对中文段落成立，所以这里按「汉字占字母的多数」给段落补 lang：
 * 中文段落标 zh-CN，多数为拉丁字母的段目标 en，数字与标点不参与投票。
 *
 * 只处理 p / li：标题走 BudouX 的 <wbr>，代码块与表格有自己的排版。
 */
const HAN = /\p{Script=Han}/gu
const LETTER = /\p{L}/gu

interface HastNode {
  readonly type: string
  readonly tagName?: string
  properties?: Record<string, unknown>
  readonly children?: readonly HastNode[]
  readonly value?: string
}

function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value ?? ''
  if (node.children === undefined) return ''
  return node.children.map(textOf).join('')
}

function languageOf(text: string): string | undefined {
  const han = text.match(HAN)?.length ?? 0
  const letters = text.match(LETTER)?.length ?? 0
  if (letters === 0) return undefined
  return han * 2 >= letters ? 'zh-CN' : 'en'
}

function walk(node: HastNode): void {
  if ((node.tagName === 'p' || node.tagName === 'li') && node.properties?.lang === undefined) {
    const language = languageOf(textOf(node))
    if (language !== undefined) node.properties = { ...node.properties, lang: language }
  }
  for (const child of node.children ?? []) walk(child)
}

export function rehypeTextLanguage() {
  return (tree: Root): void => {
    walk(tree as unknown as HastNode)
  }
}
