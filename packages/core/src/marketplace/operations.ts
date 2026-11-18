export * as MarketplaceOperations from "./operations.js"

import { Cause, Clock, Context, Effect, Exit, Fiber, Layer, Queue } from "effect"
import { MarketplaceOperation } from "@opencode/schema/marketplace-operation"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Bus } from "../bus.js"
import { MarketplaceOperationStore } from "./operation-store.js"
import { MarketplaceOperationMachine } from "./operation-machine.js"
import { MarketplaceOperationRunner } from "./operation-runner.js"
import { MarketplaceOperationContext } from "./operation-context.js"

export interface Interface {
  readonly submit: (
    input: MarketplaceOperationStore.Admission,
  ) => Effect.Effect<MarketplaceOperation.Info, MarketplaceOperationStore.ConflictError>
  readonly cancel: (
    id: MarketplaceOperation.ID,
  ) => Effect.Effect<MarketplaceOperation.Info, MarketplaceOperationStore.NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MarketplaceOperations") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* MarketplaceOperationStore.Service
    const runner = yield* MarketplaceOperationRunner.Service
    const bus = yield* Bus.Service
    const scope = yield* Effect.scope
    const wake = yield* Queue.sliding<void>(1)
    const active: {
      work?: {
        id: MarketplaceOperation.ID
        fiber: Fiber.Fiber<MarketplaceOperation.Result, MarketplaceOperation.Failure>
      }
    } = {}
    const publish = (operation: MarketplaceOperation.Info) =>
      bus.publish(MarketplaceOperation.Event.Updated, { operation }, { global: true }).pipe(Effect.asVoid)
    const phase = (id: MarketplaceOperation.ID, value: MarketplaceOperation.Phase) =>
      Effect.gen(function* () {
        const info = yield* store
          .advance(id, { type: "phase-changed", phase: value, at: yield* Clock.currentTimeMillis })
          .pipe(Effect.orDie)
        if (info.status === "cancelling")
          return yield* Effect.die(new Error("Marketplace operation cancelled before commit"))
        yield* publish(info)
      })

    const drain = Effect.gen(function* () {
      while (true) {
        const work = yield* store.claimNext()
        if (!work) return
        yield* publish(work.operation)
        const sample = { at: Number.NEGATIVE_INFINITY }
        const fiber = yield* Effect.gen(function* () {
          const current = yield* store.get(work.operation.id).pipe(Effect.orDie)
          if (current.status === "cancelling") return yield* Effect.interrupt
          return yield* runner.run(work)
        }).pipe(
          Effect.provideService(MarketplaceOperationContext.Current, {
            phase: (value) => phase(work.operation.id, value),
            progress: (progress) =>
              Effect.gen(function* () {
                const at = yield* Clock.currentTimeMillis
                if (at - sample.at < 250 && progress.completed !== progress.total) return
                const current = yield* store.get(work.operation.id).pipe(Effect.orDie)
                if (current.status !== "running") return
                sample.at = at
                yield* publish(
                  yield* store
                    .advance(current.id, { type: "phase-changed", phase: current.phase, progress, at })
                    .pipe(Effect.orDie),
                )
              }),
            commit: (tx, result, key) =>
              work.command.kind === "update-all"
                ? key === undefined
                  ? Effect.die(new Error("Bulk update commit requires a package key"))
                  : store.recordPackageWithin(tx, work.operation.id, {
                      key,
                      status: "succeeded",
                      revision: result.revision ?? 0,
                    })
                : store.completeWithin(tx, work.operation.id, result),
            outcome: (result) => store.recordPackage(work.operation.id, result),
            warning: (message) => store.warn(work.operation.id, message),
          }),
          Effect.forkChild(),
        )
        active.work = { id: work.operation.id, fiber }
        const exit = yield* Fiber.await(fiber)
        active.work = undefined
        const current = yield* store.get(work.operation.id).pipe(Effect.orDie)
        if (!MarketplaceOperationMachine.active(current)) {
          yield* publish(current)
          continue
        }
        const at = yield* Clock.currentTimeMillis
        const event: MarketplaceOperationMachine.Event =
          current.status === "cancelling"
            ? { type: "cancelled", at }
            : Exit.isSuccess(exit)
              ? { type: "succeeded", result: exit.value, at }
              : Cause.hasInterrupts(exit.cause)
                ? { type: "interrupted", at }
                : { type: "failed", error: failure(exit.cause), at }
        yield* publish(yield* store.advance(current.id, event).pipe(Effect.orDie))
      }
    })

    // Only the process-global owner performs recovery, once, before claiming any new work.
    yield* store.interruptActive()
    yield* Effect.gen(function* () {
      while (true) {
        yield* drain
        yield* Queue.take(wake)
      }
    }).pipe(Effect.forkScoped())

    return Service.of({
      submit: (input) =>
        Effect.gen(function* () {
          const operation = yield* store.enqueue(input)
          yield* publish(operation)
          yield* Queue.offer(wake, undefined)
          return operation
        }).pipe(Effect.uninterruptible),
      cancel: (id) =>
        Effect.gen(function* () {
          const operation = yield* store.advance(id, { type: "cancel-requested", at: yield* Clock.currentTimeMillis })
          yield* publish(operation)
          if (operation.status === "cancelling" && active.work?.id === id)
            yield* Fiber.interrupt(active.work.fiber).pipe(Effect.forkIn(scope), Effect.asVoid)
          return operation
        }).pipe(Effect.uninterruptible),
    })
  }),
)

function failure(cause: Cause.Cause<MarketplaceOperation.Failure>): MarketplaceOperation.Failure {
  // Typed domain failures are safe to return; defects may contain credentials or raw process output.
  const reasons = cause.reasons.filter(Cause.isFailReason)
  return reasons[0]?.error ?? { code: "internal", message: "Marketplace execution failed", retryable: true }
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [MarketplaceOperationStore.node, MarketplaceOperationRunner.node, Bus.node],
})
