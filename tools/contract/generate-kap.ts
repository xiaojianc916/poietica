/**
 * KAP 协议模型的唯一生成器：contracts/kap 的快照 → crates/kap-client/src/generated。
 *
 * 快照是唯一事实；这里不添加、不修改任何协议形状，只做 JSON Schema → serde
 * 结构的机械翻译。客户端说了什么、听了什么，由本文件尾部的两份清单声明 ——
 * 协议里其余的消息是 kimi-code 的能力，本客户端不使用，生成它们就是死代码。
 *
 * 快照里没有的路由（:fork / :undo / :abort 等动作后缀）不在清单里：生成器的
 * 输入必须存在，这些路由的补齐随快照刷新（bun run kap:spec）一起回来。
 *
 * 跑法：bun run kap:generate（package.json）。产出禁手改。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const specDir = join(repo, 'contracts', 'kap')
const outDir = join(repo, 'crates', 'kap-client', 'src', 'generated')

/**
 * 快照里实际出现的 JSON Schema 关键字。显式声明这些字段，点访问才合法；
 * 其余键留在索引签名里，`as` 收窄照旧可用。
 */
interface Schema {
  $ref?: string
  type?: string
  properties?: Record<string, Schema>
  required?: string[]
  items?: Schema
  enum?: unknown[]
  const?: unknown
  nullable?: boolean
  allOf?: Schema[]
  oneOf?: Schema[]
  anyOf?: Schema[]
  propertyNames?: Schema
  additionalProperties?: Schema
  [key: string]: unknown
}

const asyncapi = JSON.parse(readFileSync(join(specDir, 'asyncapi.json'), 'utf8'))
const openapi = JSON.parse(readFileSync(join(specDir, 'openapi.json'), 'utf8'))

/** 一条 $ref 只会在组件表里。外部引用出现即快照坏了，生成即失败。 */
function resolve(spec: { components?: Schema }, schema: Schema): Schema {
  const ref = schema.$ref
  if (typeof ref !== 'string') {
    return schema
  }
  if (!ref.startsWith('#/components/')) {
    throw new Error(`unsupported $ref outside components: ${ref}`)
  }
  let node: unknown = spec
  for (const part of ref.slice(2).split('/')) {
    node = (node as Schema)[part]
    if (node === undefined) {
      throw new Error(`dangling $ref: ${ref}`)
    }
  }
  return node as Schema
}

function pascal(text: string): string {
  return text
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => {
      const head = part.slice(0, 1).toUpperCase()
      return `${head}${part.slice(1)}`
    })
    .join('')
}

function snake(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase())
    .join('_')
}

const RUST_KEYWORDS = new Set([
  'as',
  'break',
  'const',
  'continue',
  'crate',
  'dyn',
  'else',
  'enum',
  'extern',
  'fn',
  'for',
  'if',
  'impl',
  'in',
  'let',
  'loop',
  'match',
  'mod',
  'move',
  'mut',
  'pub',
  'ref',
  'return',
  'self',
  'static',
  'struct',
  'super',
  'trait',
  'type',
  'union',
  'unsafe',
  'use',
  'where',
  'while',
  'async',
  'await',
  'box',
  'override',
])

/** 判别式字段在这一支里钉住的值（const 或单值 enum）。 */
function discriminatorValue(branch: Schema, tag: string): string | undefined {
  const child = ((branch['properties'] ?? {}) as Record<string, Schema>)[tag]
  if (child === undefined) {
    return undefined
  }
  if (typeof child.const === 'string') {
    return child.const
  }
  if (Array.isArray(child.enum) && child.enum.length === 1 && typeof child.enum[0] === 'string') {
    return child.enum[0]
  }
  return undefined
}

/** 快照只用 allOf 叠一层；逐支合并 properties/required 后按对象处理。 */
function mergeAllOf(spec: { components?: Schema }, schema: Schema): Schema {
  const merged: Schema = { type: 'object', properties: {}, required: [] }
  for (const part of (schema.allOf ?? []) as Schema[]) {
    const piece = resolve(spec, part)
    Object.assign(merged.properties as Schema, piece.properties ?? {})
    for (const required of (piece.required as string[]) ?? []) {
      ;(merged.required as string[]).push(required)
    }
  }
  return merged
}

const isStringEnum = (resolved: Schema): boolean =>
  Array.isArray(resolved.enum) && resolved.enum.every((value) => typeof value === 'string')

type TypeOf = (schema: Schema, hint: string) => string

/** 一条 struct 字段：判别式之外的格子，按 required/nullable 决定可缺省。 */
function structField(
  typeOf: TypeOf,
  child: Schema,
  key: string,
  hint: string,
  required: Set<string>,
): string {
  const optional = !required.has(key) || child.nullable === true
  const inner = typeOf(child, hint)
  const attrs = [`#[serde(rename = ${JSON.stringify(key)})]`]
  if (optional) {
    // 序列化时缺席字段不上 wire：协议把它们声明为可选，显式 null 反而是
    // 另一种形状。
    attrs.push('#[serde(default, skip_serializing_if = "Option::is_none")]')
  }
  const ty = optional ? `Option<${inner}>` : inner
  const field = snake(key)
  const ident = RUST_KEYWORDS.has(field) ? `r#${field}` : field
  return `    ${attrs.join(' ')}\n    pub ${ident}: ${ty},`
}

/** 一条 enum 变体：判别式钉在 wire 的字段上，其余格子平铺进变体。 */
function oneOfVariant(
  typeOf: TypeOf,
  branch: Schema,
  index: number,
  name: string,
  tag: string | null,
): string {
  const value = tag === null ? undefined : discriminatorValue(branch, tag)
  const label =
    value !== undefined ? pascal(value) : pascal(`${name.replace(/Choice$/, '')}${index}`)
  const fields: string[] = []
  for (const [key, child] of Object.entries(
    (branch['properties'] ?? {}) as Record<string, Schema>,
  )) {
    if (key === tag) {
      continue
    }
    const required = new Set((branch['required'] as string[]) ?? [])
    const optional = !required.has(key) || child.nullable === true
    const inner = typeOf(child, `${name}${label}${pascal(key)}`)
    const attrs = [`#[serde(rename = ${JSON.stringify(key)})]`]
    if (optional) {
      attrs.push('#[serde(default, skip_serializing_if = "Option::is_none")]')
    }
    const ty = optional ? `Option<${inner}>` : inner
    const field = snake(key)
    const ident = RUST_KEYWORDS.has(field) ? `r#${field}` : field
    fields.push(`        ${attrs.join(' ')}\n        ${ident}: ${ty},`)
  }
  const body = fields.length === 0 ? ',' : ` {\n${fields.join('\n')}\n    },`
  const attrs =
    tag === null || value === undefined ? '' : `    #[serde(rename = ${JSON.stringify(value)})]\n`
  return `${attrs}    ${label}${body}`
}

/**
 * schema → Rust 类型的翻译器。同一个形状只生成一个类型：判据是 schema 的
 * 规范化文本；每条声明按出现序落进 decls。
 */
class RustEmitter {
  private readonly decls: string[] = []
  private readonly taken = new Set<string>()
  private readonly canonical = new Map<string, string>()
  /** 每个已生成类型能否 derive(Default)：必填的 enum/choice 字段会挡住它。 */
  private readonly defaultable = new Map<string, boolean>()

  private readonly spec: { components?: Schema }

  constructor(spec: { components?: Schema }) {
    this.spec = spec
  }

  get declarations(): string[] {
    return this.decls
  }

  /** 引用某 schema 的 Rust 类型；无名内联结构以 hint 命名。 */
  type(schema: Schema, hint: string): string {
    const resolved = resolve(this.spec, schema)
    const key = JSON.stringify(resolved, Object.keys(resolved).sort())
    const known = this.canonical.get(key)
    if (known !== undefined) {
      return known
    }

    const produced = this.shapeOf(resolved, hint)
    this.canonical.set(key, produced)
    return produced
  }

  private shapeOf(resolved: Schema, hint: string): string {
    if (Array.isArray(resolved.oneOf) || Array.isArray(resolved.anyOf)) {
      return this.oneOf(resolved, hint)
    }
    if (Array.isArray(resolved.allOf)) {
      return this.type(mergeAllOf(this.spec, resolved), hint)
    }
    return this.nominal(resolved, hint)
  }

  private nominal(resolved: Schema, hint: string): string {
    switch (resolved.type) {
      case 'object':
        return this.object(resolved, hint)
      case 'array':
        return `Vec<${this.type((resolved.items ?? {}) as Schema, hint)}>`
      case 'string':
        return isStringEnum(resolved) ? this.stringEnum(resolved, hint) : 'String'
      case 'integer':
        return 'i64'
      case 'number':
        return 'f64'
      case 'boolean':
        return 'bool'
      default:
        // 无 type 的空 schema（{}、details 等）是协议自己声明的透传位。
        return 'serde_json::Value'
    }
  }

  /** 找出各支共有的判别式字段：每支里它是 const 或单值 enum。 */
  private static discriminatorOf(branches: Schema[]): string | null {
    const head = branches.at(0)
    if (head === undefined) {
      return null
    }
    const first = Object.keys((head['properties'] ?? {}) as Record<string, Schema>)
    for (const key of first) {
      const holds = (branch: Schema): boolean => discriminatorValue(branch, key) !== undefined
      if (branches.every((branch) => holds(branch))) {
        return key
      }
    }
    return null
  }

  private oneOf(schema: Schema, hint: string): string {
    const branches = ((schema['oneOf'] ?? schema['anyOf']) as Schema[]).map((b) =>
      resolve(this.spec, b),
    )
    const name = this.unique(`${hint}Choice`)
    this.defaultable.set(name, false)
    const tag = RustEmitter.discriminatorOf(branches)
    const serdeTag = tag === null ? '#[serde(untagged)]' : `#[serde(tag = ${JSON.stringify(tag)})]`

    const variants = branches.map((branch, index) =>
      oneOfVariant(this.type.bind(this), branch, index, name, tag),
    )

    this.decls.push(
      `#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]\n${serdeTag}\npub enum ${name} {\n${variants.join('\n')}\n}`,
    )
    return name
  }

  private object(schema: Schema, hint: string): string {
    const properties = (schema['properties'] ?? {}) as Record<string, Schema>
    const required = new Set((schema.required as string[] | undefined) ?? [])
    const names = (schema['propertyNames'] ?? null) as Schema | null

    // propertyNames + additionalProperties 是动态键的表，Rust 侧就是 HashMap。
    if (names !== null && Object.keys(properties).length === 0) {
      const value = this.type((schema['additionalProperties'] ?? {}) as Schema, `${hint}Value`)
      return `std::collections::HashMap<String, ${value}>`
    }

    if (Object.keys(properties).length === 0) {
      return 'serde_json::Value'
    }

    const name = this.unique(`${hint}Struct`)
    const fields: string[] = []
    let canDefault = true
    for (const [key, child] of Object.entries(properties)) {
      const inner = this.type(child, `${hint}${pascal(key)}`)
      // 必填字段引用一个非 Default 类型（enum/choice 或自身不可 Default 的
      // 结构）时，这个结构也派生不出 Default。
      if (required.has(key) && child.nullable !== true && this.defaultable.get(inner) === false) {
        canDefault = false
      }
      fields.push(structField(this.type.bind(this), child, key, `${hint}${pascal(key)}`, required))
    }

    this.defaultable.set(name, canDefault)
    this.decls.push(
      `#[derive(Debug, Clone, PartialEq${canDefault ? ', Default' : ''}, serde::Serialize, serde::Deserialize)]\npub struct ${name} {\n${fields.join('\n')}\n}`,
    )
    return name
  }

  private stringEnum(schema: Schema, hint: string): string {
    const name = this.unique(`${hint}Enum`)
    this.defaultable.set(name, false)
    const variants = (schema.enum as string[]).map((value) => {
      const label = pascal(value) || 'Blank'
      return `    #[serde(rename = ${JSON.stringify(value)})]
    ${label},`
    })
    this.decls.push(
      `#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]\npub enum ${name} {\n${variants.join('\n')}\n}`,
    )
    return name
  }

  private unique(base: string): string {
    const name = pascal(base)
    if (this.taken.has(name)) {
      throw new Error(`duplicate type name: ${name}`)
    }
    this.taken.add(name)
    return name
  }
}

// ── WS 控制面（asyncapi.json）───────────────────────────────────────────────

/** 客户端会说的话。快照里其余消息（terminal、watch_fs、unsubscribe…）本客户端不用。 */
const CLIENT_MESSAGES = ['client_hello', 'subscribe', 'pong'] as const

/** 服务端会说的话；ack 的载荷按请求种类各自成模型，由客户端按关联的 id 挑。 */
const SERVER_MESSAGES = ['server_hello', 'ping', 'resync_required', 'error'] as const
const ACK_PAYLOADS = ['client_hello_ack', 'subscribe_ack', 'abort_ack'] as const

interface Asyncapi {
  components?: { messages?: Record<string, Schema> }
}

/** asyncapi 消息的 payload 字段（信封里真正干活的那半）。 */
function messagePayload(spec: Asyncapi, message: Schema): Schema {
  const envelope = resolve(spec, (message['payload'] ?? {}) as Schema)
  return resolve(spec, (envelope['properties']?.['payload'] ?? {}) as Schema)
}

interface WireVariant {
  rename: string
  label: string
  fields: string
}

function wireEnum(name: string, doc: string, variants: WireVariant[]): string {
  const body = variants
    .map(({ rename, label, fields }) => {
      const attrs = rename === label ? '' : `    #[serde(rename = ${JSON.stringify(rename)})]\n`
      // 枚举变体的字段随枚举的可见性走，不写 pub。
      const bare = fields.replaceAll('pub ', '')
      return `${attrs}    ${label} {\n${bare}\n    },`
    })
    .join('\n')
  return `/// ${doc}\n#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]\n#[serde(tag = "type")]\npub enum ${name} {\n${body}\n}`
}

/** asyncapi 组件表。消息清单里出现不认识的键就是快照坏了。 */
/** asyncapi 组件表。消息清单里出现不认识的键就是快照坏了。 */
function specMessages(): Record<string, Schema> {
  const messages = asyncapi.components?.messages
  if (messages === undefined) {
    throw new Error('asyncapi has no component messages')
  }
  return messages
}

function specMessage(messages: Record<string, Schema>, name: string): Schema {
  const message = messages[name]
  if (message === undefined) {
    throw new Error(`message not in spec: ${name}`)
  }
  return resolve(asyncapi, message)
}

function generateEvents(): string {
  const messages = specMessages()

  const out: string[] = []

  const client = new RustEmitter(asyncapi)
  const clientVariants = CLIENT_MESSAGES.map((messageName) => {
    const message = specMessage(messages, messageName)
    const payload = client.type(messagePayload(asyncapi, message), pascal(messageName))
    const envelope = resolve(asyncapi, (message['payload'] ?? {}) as Schema)
    const hasId = ((envelope['required'] as string[]) ?? []).includes('id')
    const fields = [
      ...(hasId ? ['        pub id: String,'] : []),
      `        pub payload: ${payload},`,
    ].join('\n')
    return { rename: messageName, label: pascal(messageName), fields }
  })
  out.push(wireEnum('ClientFrame', '客户端发往 server 的控制帧。', clientVariants))
  out.push(...client.declarations)

  const server = new RustEmitter(asyncapi)

  // ack 的形状分散在每条 *_ack 消息里，但它们的信封同形（type 常量都是 "ack"，
  // 外格是 id/code/msg）。按第一条 ack 消息的信封给这三格定出类型合成 Ack
  // 变体；payload 按请求种类各异，由客户端按关联的 id 在调用点解码。
  const ackEnvelope = resolve(
    asyncapi,
    (specMessage(messages, ACK_PAYLOADS[0])['payload'] ?? {}) as Schema,
  )
  const ackFields =
    Object.entries((ackEnvelope['properties'] ?? {}) as Record<string, Schema>)
      .filter(([key]) => key !== 'type' && key !== 'payload')
      .map(([key, child]) => {
        const required = new Set((ackEnvelope['required'] as string[]) ?? [])
        const optional = !required.has(key) || child['nullable'] === true
        const inner = server.type(child, `Ack${pascal(key)}`)
        const ty = optional ? `Option<${inner}>` : inner
        const attrs = optional
          ? `#[serde(rename = ${JSON.stringify(key)})] #[serde(default, skip_serializing_if = "Option::is_none")]`
          : `#[serde(rename = ${JSON.stringify(key)})]`
        return `        ${attrs}\n        pub ${snake(key)}: ${ty},`
      })
      .join('\n') +
    // ack 的载荷按请求种类各异：信封上它是一格透传位，调用点再按请求解码。
    `\n        #[serde(rename = "payload")]\n        pub payload: serde_json::Value,`

  const serverVariants: WireVariant[] = [
    { rename: 'ack', label: 'Ack', fields: ackFields },
    ...SERVER_MESSAGES.map((messageName) => {
      const message = specMessage(messages, messageName)
      const envelope = resolve(asyncapi, (message['payload'] ?? {}) as Schema)
      const payload = server.type(messagePayload(asyncapi, message), pascal(messageName))
      const required = new Set((envelope['required'] as string[]) ?? [])
      const props = (envelope['properties'] ?? {}) as Record<string, Schema>
      const fields = Object.entries(props)
        .filter(([key]) => key !== 'type' && key !== 'payload')
        .map(([key, child]) => {
          const optional = !required.has(key) || child['nullable'] === true
          const inner = server.type(child, `${pascal(messageName)}${pascal(key)}`)
          const attrs = [`#[serde(rename = ${JSON.stringify(key)})]`]
          if (optional) {
            attrs.push('#[serde(default, skip_serializing_if = "Option::is_none")]')
          }
          const ty = optional ? `Option<${inner}>` : inner
          return `        ${attrs.join(' \n ')}\n        pub ${snake(key)}: ${ty},`
        })
      fields.push(`        #[serde(rename = "payload")]\n        pub payload: ${payload},`)
      return { rename: messageName, label: pascal(messageName), fields: fields.join('\n') }
    }),
  ]
  out.push(
    wireEnum(
      'ServerFrame',
      'server 发来的控制帧。ack 的载荷在调用点按请求种类解码。',
      serverVariants,
    ),
  )
  out.push(...server.declarations)

  const acks = new RustEmitter(asyncapi)
  for (const messageName of ACK_PAYLOADS) {
    acks.type(
      messagePayload(asyncapi, specMessage(messages, messageName)),
      `${pascal(messageName)}Payload`,
    )
  }
  out.push('/// 各类 ack 的载荷。客户端按发出去的那条请求挑模型解码。')
  out.push(...acks.declarations)

  // 会话事件帧：信封的每个格子都有名字，载荷留给 translate 层（管道收敛批）。
  const session = new RustEmitter(asyncapi)
  const message = specMessage(messages, 'session_event')
  const envelope = resolve(asyncapi, (message['payload'] ?? {}) as Schema)
  const required = new Set((envelope['required'] as string[]) ?? [])
  const props = (envelope.properties ?? {}) as Record<string, Schema>
  const sessionFields = Object.entries(props)
    .filter(([key]) => key !== 'type' && key !== 'payload')
    .map(([key, child]) => {
      const optional = !required.has(key) || child.nullable === true
      const inner = session.type(child, `SessionEvent${pascal(key)}`)
      const attrs = [`#[serde(rename = ${JSON.stringify(key)})]`]
      if (optional) {
        attrs.push('#[serde(default, skip_serializing_if = "Option::is_none")]')
      }
      const ty = optional ? `Option<${inner}>` : inner
      return `    ${attrs.join(' ')}\n    pub ${snake(key)}: ${ty},`
    })
    .join('\n')
  out.push(
    `/// 会话事件帧的信封：路由与去重读它，载荷原样穿过，translate 层接上后收口。\n#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]\npub struct SessionEventFrame {\n${sessionFields}\n}`,
  )
  out.push(...session.declarations)

  return out.join('\n\n')
}

// ── REST 面（openapi.json）─────────────────────────────────────────────────

interface RestRoute {
  method: string
  path: string
  name: string
  request?: boolean
  data?: boolean
}

/** 客户端会走的路由。name 即生成类型的前缀；request/data 声明要生成哪一半。 */
const REST_ROUTES: RestRoute[] = [
  { method: 'post', path: '/api/v1/sessions', name: 'CreateSession', request: true, data: true },
  { method: 'get', path: '/api/v1/sessions', name: 'ListSessions', data: true },
  {
    method: 'get',
    path: '/api/v1/sessions/{session_id}/status',
    name: 'SessionStatus',
    data: true,
  },
  { method: 'get', path: '/api/v1/config', name: 'ClientConfig', data: true },
  {
    method: 'post',
    path: '/api/v1/sessions/{session_id}/profile',
    name: 'SetProfile',
    request: true,
  },
  {
    method: 'get',
    path: '/api/v1/sessions/{session_id}/approvals',
    name: 'ListApprovals',
    data: true,
  },
  {
    method: 'post',
    path: '/api/v1/sessions/{session_id}/approvals/{approval_id}',
    name: 'ResolveApproval',
    request: true,
  },
  {
    method: 'get',
    path: '/api/v1/sessions/{session_id}/questions',
    name: 'ListQuestions',
    data: true,
  },
  {
    method: 'post',
    path: '/api/v1/sessions/{session_id}/questions/{tail}',
    name: 'AnswerQuestion',
    request: true,
  },
  {
    method: 'post',
    path: '/api/v1/sessions/{session_id}/prompts',
    name: 'SubmitPrompt',
    request: true,
    data: true,
  },
  {
    method: 'post',
    path: '/api/v1/sessions/{session_id}/prompts:steer',
    name: 'SteerPrompts',
    request: true,
  },
  {
    method: 'post',
    path: '/api/v1/sessions/{session_id}:archive',
    name: 'ArchiveSession',
    request: true,
  },
  { method: 'get', path: '/api/v1/sessions/{session_id}/skills', name: 'ListSkills', data: true },
  { method: 'get', path: '/api/v1/mcp/servers', name: 'ListMcpServers', data: true },
  { method: 'get', path: '/api/v1/sessions/{session_id}/goal', name: 'SessionGoal', data: true },
  { method: 'get', path: '/api/v1/models', name: 'ListModels', data: true },
]

function generateRest(): string {
  const rest = new RustEmitter(openapi)

  for (const route of REST_ROUTES) {
    const op = (openapi.paths as Record<string, Record<string, Schema>>)[route.path]?.[route.method]
    if (op === undefined) {
      throw new Error(`route not in spec: ${route.method.toUpperCase()} ${route.path}`)
    }

    if (route.request) {
      const body = resolve(openapi, jsonSchema(op['requestBody'] as Schema | undefined))
      rest.type(body, `${route.name}Request`)
    }
    if (route.data) {
      const response = resolve(
        openapi,
        jsonSchema((op['responses'] as Record<string, Schema>)['200']),
      )
      const branches = ((response['oneOf'] ?? [response]) as Schema[]).map((b) =>
        resolve(openapi, b),
      )
      const success = branches.find((b) => {
        const code = (b['properties']?.['code'] as Schema | undefined)?.['enum']
        return Array.isArray(code) && code[0] === 0
      })
      if (success === undefined) {
        throw new Error(`no success branch on ${route.method.toUpperCase()} ${route.path}`)
      }
      const data = resolve(openapi, (success['properties']?.['data'] ?? {}) as Schema)
      if (Object.keys(data).length === 0) {
        throw new Error(
          `success branch has no data shape on ${route.method.toUpperCase()} ${route.path}`,
        )
      }
      rest.type(data, `${route.name}Data`)
    }
  }

  const envelopeShape = successEnvelopeShape()
  return [
    '/// REST 应答信封：每条路由的成功/错误分支共用同一组外格，data 各有模型。',
    envelopeShape,
    ...rest.declarations,
  ].join('\n\n')
}

function jsonSchema(container: Schema | undefined): Schema {
  const schema = (container?.['content'] as Record<string, Schema> | undefined)?.[
    'application/json'
  ]?.['schema']
  if (schema === undefined) {
    throw new Error('no application/json schema')
  }
  return schema as Schema
}

/** 信封形状从第一条带 data 的路由读出；各路由的分支外格一致，这里断言一次。 */
function successEnvelopeShape(): string {
  const fields = ['code', 'msg', 'data', 'request_id', 'details']
  for (const route of REST_ROUTES) {
    const op = (openapi.paths as Record<string, Record<string, Schema>>)[route.path]?.[route.method]
    if (op?.['responses'] === undefined) {
      continue
    }
    const response = resolve(
      openapi,
      jsonSchema((op['responses'] as Record<string, Schema>)['200']),
    )
    const branches = ((response['oneOf'] ?? [response]) as Schema[]).map((b) => resolve(openapi, b))
    for (const branch of branches) {
      const props = Object.keys((branch['properties'] ?? {}) as Schema)
      for (const field of fields) {
        if (!props.includes(field)) {
          throw new Error(
            `envelope field ${field} missing on ${route.method.toUpperCase()} ${route.path}`,
          )
        }
      }
    }
    if (branches.length > 0) {
      break
    }
  }
  return `#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]\npub struct RestEnvelope {\n    pub code: i64,\n    pub msg: String,\n    #[serde(default)]\n    pub data: Option<serde_json::Value>,\n    #[serde(default, rename = "request_id")]\n    pub request_id: Option<String>,\n    #[serde(default)]\n    pub details: Option<serde_json::Value>,\n}`
}

// ── 落盘 ────────────────────────────────────────────────────────────────────

const HEADER = `// @generated by tools/contract/generate-kap.ts from contracts/kap 的快照。
// 禁手改：改协议先刷快照（bun run kap:spec），再重新生成（bun run kap:generate）。`

function emit(file: string, body: string): void {
  mkdirSync(outDir, { recursive: true })
  const header = `${HEADER}
#![allow(clippy::large_enum_variant, reason = "the wire shapes are what the spec says; splitting them adds nothing")]
`
  const target = join(outDir, file)
  /* 暂存-格式化-换名：格式化失败时目标文件原封不动，不留半份生成物。 */
  const staged = `${target}.staged`
  writeFileSync(staged, `${header}\n${body}\n`)
  // 生成物按仓库的 rustfmt 纪律走：写完即格式化，重复生成才是幂等的。
  const formatted = Bun.spawnSync(['rustfmt', '--edition', '2024', staged])
  if (formatted.exitCode !== 0) {
    rmSync(staged, { force: true })
    throw new Error(`rustfmt rejected ${file}: ${formatted.stderr.toString()}`)
  }
  renameSync(staged, target)
  console.log(`wrote ${file}`)
}

emit('events.rs', generateEvents())
emit('rest.rs', generateRest())
