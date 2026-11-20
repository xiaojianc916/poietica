import { loadDefaultSimplifiedChineseParser } from 'budoux'
import { Children, Fragment, type ReactNode } from 'react'

/*
 * 中文标题的词间断点。
 *
 * 浏览器把每一个汉字都当成一个断行机会，标题因此可能把「定时任务」拆成「定时／任务」之外的两截。
 * BudouX 给出词与词的边界，这里在边界插 <wbr>；配合标题上的 word-break: keep-all，换行只落在
 * 这些显式机会上。正文不走这条路：正文的标点避头尾与两端对齐由浏览器自己处理。
 *
 * 解析结果按文案缓存。标题是少数几串字，缓存上限只是防止用户改名（动态标题）把表涨成无界。
 */
const parser = loadDefaultSimplifiedChineseParser()
const cache = new Map<string, readonly string[]>()
const CACHE_LIMIT = 512
const HAN = /\p{Script=Han}/u

function chunksOf(text: string): readonly string[] {
  const cached = cache.get(text)
  if (cached !== undefined) return cached
  const chunks = parser.parse(text)
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(text, chunks)
  return chunks
}

function segmented(text: string): ReactNode {
  if (!HAN.test(text)) return text
  const chunks = chunksOf(text)
  if (chunks.length < 2) return text
  return chunks.map((chunk, index) => (
    <Fragment key={`${String(index)}:${chunk}`}>
      {index === 0 ? null : <wbr />}
      {chunk}
    </Fragment>
  ))
}

/**
 * 只切中文文案；英文、数字与 React 元素原样传下去。
 * 元素（例如计数 span）不递归：那些格子有自己的排版，拆开只会把组件边界弄丢。
 */
export function CjkText({ children }: { readonly children: ReactNode }): ReactNode {
  return Children.map(children, (child) => (typeof child === 'string' ? segmented(child) : child))
}
