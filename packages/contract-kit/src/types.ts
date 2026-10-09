import type { z } from 'zod'
import type { Contract, MethodDef, NotificationDef } from './define'

export type MethodName<C extends Contract> = C['methods'][number]['name']
export type NotificationName<C extends Contract> = C['notifications'][number]['name']
export type MethodOf<C extends Contract, N extends MethodName<C>> = Extract<C['methods'][number], { name: N }>
export type NotificationOf<C extends Contract, N extends NotificationName<C>> = Extract<
  C['notifications'][number],
  { name: N }
>
export type ParamsIn<C extends Contract, N extends MethodName<C>> = z.input<MethodOf<C, N>['params']>
export type ParamsOut<C extends Contract, N extends MethodName<C>> = z.output<MethodOf<C, N>['params']>
export type ResultOf<C extends Contract, N extends MethodName<C>> = z.output<MethodOf<C, N>['result']>
export type NotificationParams<C extends Contract, N extends NotificationName<C>> = z.output<
  NotificationOf<C, N>['params']
>
export type AnyMethod = MethodDef<string, z.ZodType, z.ZodType>
export type AnyNotification = NotificationDef<string, z.ZodType>
