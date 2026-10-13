export interface ServiceToken<T> {
  readonly ownerModule: string // 提供方模块 id
  readonly name: string
  readonly __type?: T // 只用于类型推导，运行时不存在
}

export function defineServiceToken<T>(ownerModule: string, name: string): ServiceToken<T> {
  return Object.freeze({ ownerModule, name }) as ServiceToken<T>
}
