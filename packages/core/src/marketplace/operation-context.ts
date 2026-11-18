export * as MarketplaceOperationContext from "./operation-context.js"

import { Context, Effect } from "effect"
import type { MarketplaceOperation } from "@opencode/schema/marketplace-operation"
import type { Database } from "../database/database.js"

export type Executor = Pick<Database.Interface["db"], "all" | "run">

export interface Run {
  readonly phase: (phase: MarketplaceOperation.Phase) => Effect.Effect<void>
  readonly progress: (progress: MarketplaceOperation.Progress) => Effect.Effect<void>
  readonly commit: (tx: Executor, result: MarketplaceOperation.Result, key?: string) => Effect.Effect<void>
  readonly outcome: (result: MarketplaceOperation.PackageResult) => Effect.Effect<void>
  readonly warning: (message: string) => Effect.Effect<void>
}

/** Execution-local capabilities, supplied by the worker, never captured from an HTTP request. */
export const Current = Context.Reference<Run | undefined>("@opencode/MarketplaceOperationContext", {
  defaultValue: () => undefined,
})

export const phase = Effect.fnUntraced(function* (value: MarketplaceOperation.Phase) {
  const current = yield* Current
  if (current) yield* current.phase(value)
})
