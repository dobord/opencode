import { expect } from "bun:test"
import { Deferred, Effect, Layer, Queue, Stream } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { MarketplaceOperation } from "@opencode/schema/marketplace-operation"
import { Location } from "../../src/location.js"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { Database } from "../../src/database/database.js"
import { Bus } from "../../src/bus.js"
import { MarketplaceOperations } from "../../src/marketplace/operations.js"
import { MarketplaceOperationStore } from "../../src/marketplace/operation-store.js"
import { MarketplaceOperationRunner } from "../../src/marketplace/operation-runner.js"
import { MarketplaceOperationContext } from "../../src/marketplace/operation-context.js"
import { MarketplaceRegistry } from "../../src/marketplace/registry.js"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Database.node, Bus.node, MarketplaceOperationStore.node, MarketplaceRegistry.node]),
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })

it.effect("publishes request-originated admissions globally rather than routing them only to that Location", () =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const received = yield* Deferred.make<boolean>()
    yield* bus.subscribe(MarketplaceOperation.Event.Updated).pipe(
      Stream.runForEach((event) =>
        event.data.operation.status === "queued"
          ? Deferred.succeed(received, event.location === undefined)
          : Effect.void,
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* Effect.gen(function* () {
      const operations = yield* MarketplaceOperations.Service
      yield* operations.submit({ request_id: "global", location, command: { kind: "refresh" } }).pipe(
        Effect.provideService(Location.Service, {
          ...location,
          project: { id: Project.ID.make("global"), directory: location.directory, canonical: location.directory },
        }),
      )
      expect(yield* Deferred.await(received)).toBe(true)
    }).pipe(
      Effect.provide(
        MarketplaceOperations.layer.pipe(
          Layer.provide(Layer.succeed(MarketplaceOperationRunner.Service, { run: () => Effect.succeed({}) })),
        ),
      ),
    )
  }),
)

const observe = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const queue = yield* Queue.unbounded<MarketplaceOperation.Info>()
  yield* bus.subscribe(MarketplaceOperation.Event.Updated).pipe(
    Stream.runForEach((event) => Queue.offer(queue, event.data.operation)),
    Effect.forkScoped({ startImmediately: true }),
  )
  return queue
})

const until = Effect.fnUntraced(function* (
  queue: Queue.Queue<MarketplaceOperation.Info>,
  id: MarketplaceOperation.ID,
  status: MarketplaceOperation.Status,
): Effect.fn.Return<MarketplaceOperation.Info> {
  const info = yield* Queue.take(queue)
  if (info.id === id && info.status === status) return info
  return yield* until(queue, id, status)
})

it.effect("retains committed package outcomes when a bulk update is interrupted before completion", () =>
  Effect.gen(function* () {
    const store = yield* MarketplaceOperationStore.Service
    const registry = yield* MarketplaceRegistry.Service
    const batch = yield* store.enqueue({ request_id: "batch", location, command: { kind: "update-all" } })
    yield* store.claimNext()
    yield* store.advance(batch.id, { type: "phase-changed", phase: "applying", at: 1 })
    yield* registry.replace(
      { revision: 0, sources: [{ id: "source", name: "Source", url: "https://example.test/catalog.json" }] },
      (tx, result) =>
        store.recordPackageWithin(tx, batch.id, {
          key: "good",
          status: "succeeded",
          revision: result.state.revision ?? 0,
        }),
    )
    expect((yield* store.get(batch.id)).status).toBe("running")
    yield* store.enqueue({ request_id: "next", location, command: { kind: "prune" } })
    expect(yield* store.claimNext()).toBeUndefined()
    yield* store.advance(batch.id, { type: "phase-changed", phase: "checking-conflicts", at: 2 })
    yield* store.recordPackage(batch.id, {
      key: "bad",
      status: "failed",
      error: { code: "download", message: "HTTP 429", retryable: true },
    })
    expect(yield* store.interruptActive()).toBe(1)
    expect(yield* store.get(batch.id)).toMatchObject({
      status: "interrupted",
      outcomes: [
        { key: "good", status: "succeeded", revision: 1 },
        { key: "bad", status: "failed" },
      ],
    })
    expect((yield* registry.read()).revision).toBe(1)
  }),
)

it.effect("rejects cancellation at the registry commit boundary without reporting a false cancellation", () =>
  Effect.gen(function* () {
    const queue = yield* observe
    const registry = yield* MarketplaceRegistry.Service
    const applying = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    yield* Effect.gen(function* () {
      const operations = yield* MarketplaceOperations.Service
      const first = yield* operations.submit({
        request_id: "applying",
        location,
        command: { kind: "source-remove", id: "source" },
      })
      yield* Deferred.await(applying)
      expect(yield* operations.cancel(first.id)).toMatchObject({ status: "running", phase: "applying" })
      yield* Deferred.succeed(release, undefined)
      expect(yield* until(queue, first.id, "succeeded")).toMatchObject({ result: { changed: false, revision: 0 } })
    }).pipe(
      Effect.provide(
        MarketplaceOperations.layer.pipe(
          Layer.provide(
            Layer.succeed(MarketplaceOperationRunner.Service, {
              run: () =>
                Effect.gen(function* () {
                  const current = yield* MarketplaceOperationContext.Current
                  if (!current) throw new Error("Expected worker capabilities")
                  yield* current.phase("applying")
                  yield* Deferred.succeed(applying, undefined)
                  yield* Deferred.await(release)
                  const stored = yield* registry
                    .replace({ revision: 0 }, (tx, result) =>
                      current.commit(tx, { revision: result.state.revision, changed: result.changed }),
                    )
                    .pipe(Effect.orDie)
                  return { revision: stored.state.revision, changed: stored.changed }
                }),
            }),
          ),
        ),
      ),
    )
  }),
)

it.effect("keeps admitted work alive after the submitting scope closes and serializes execution", () =>
  Effect.gen(function* () {
    const queue = yield* observe
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const calls: string[] = []
    const runner = MarketplaceOperationRunner.Service.of({
      run: (work) =>
        Effect.gen(function* () {
          calls.push(work.command.kind)
          if (work.command.kind === "refresh") {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
          }
          return { changed: false }
        }),
    })
    yield* Effect.gen(function* () {
      const operations = yield* MarketplaceOperations.Service
      const store = yield* MarketplaceOperationStore.Service
      const first = yield* operations
        .submit({ request_id: "first", location, command: { kind: "refresh" } })
        .pipe(Effect.scoped)
      yield* Deferred.await(started)
      const second = yield* operations.submit({ request_id: "second", location, command: { kind: "prune" } })
      expect((yield* store.get(second.id)).status).toBe("queued")
      expect(calls).toEqual(["refresh"])
      yield* Deferred.succeed(release, undefined)
      yield* until(queue, first.id, "succeeded")
      yield* until(queue, second.id, "succeeded")
      expect(calls).toEqual(["refresh", "prune"])
      expect((yield* operations.submit({ request_id: "first", location, command: { kind: "refresh" } })).status).toBe(
        "succeeded",
      )
      expect(calls).toHaveLength(2)
    }).pipe(
      Effect.provide(
        MarketplaceOperations.layer.pipe(Layer.provide(Layer.succeed(MarketplaceOperationRunner.Service, runner))),
      ),
    )
  }),
)

it.effect("waits for cancellation cleanup before starting the next operation", () =>
  Effect.gen(function* () {
    const queue = yield* observe
    const started = yield* Deferred.make<void>()
    const cleaning = yield* Deferred.make<void>()
    const cleaned = yield* Deferred.make<void>()
    const calls: string[] = []
    const runner = MarketplaceOperationRunner.Service.of({
      run: (work) =>
        Effect.gen(function* () {
          calls.push(work.command.kind)
          if (work.command.kind !== "refresh") return {}
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(cleaned))),
          )
          yield* Deferred.succeed(started, undefined)
          return yield* Effect.never
        }).pipe(Effect.scoped),
    })
    yield* Effect.gen(function* () {
      const operations = yield* MarketplaceOperations.Service
      const first = yield* operations.submit({ request_id: "first", location, command: { kind: "refresh" } })
      yield* Deferred.await(started)
      const second = yield* operations.submit({ request_id: "second", location, command: { kind: "prune" } })
      expect((yield* operations.cancel(first.id)).status).toBe("cancelling")
      yield* Deferred.await(cleaning)
      expect(calls).toEqual(["refresh"])
      yield* Deferred.succeed(cleaned, undefined)
      yield* until(queue, first.id, "cancelled")
      yield* until(queue, second.id, "succeeded")
      expect(calls).toEqual(["refresh", "prune"])
    }).pipe(
      Effect.provide(
        MarketplaceOperations.layer.pipe(Layer.provide(Layer.succeed(MarketplaceOperationRunner.Service, runner))),
      ),
    )
  }),
)

it.effect("recovers interrupted work only at worker startup and drains retained queued work", () =>
  Effect.gen(function* () {
    const queue = yield* observe
    const store = yield* MarketplaceOperationStore.Service
    const old = yield* store.enqueue({ request_id: "old", location, command: { kind: "refresh" } })
    yield* store.claimNext()
    const next = yield* store.enqueue({ request_id: "next", location, command: { kind: "prune" } })
    const calls: string[] = []
    yield* Effect.gen(function* () {
      expect((yield* store.get(old.id)).status).toBe("interrupted")
      yield* until(queue, next.id, "succeeded")
      expect(calls).toEqual(["prune"])
    }).pipe(
      Effect.provide(
        MarketplaceOperations.layer.pipe(
          Layer.provide(
            Layer.succeed(MarketplaceOperationRunner.Service, {
              run: (work) =>
                Effect.sync(() => {
                  calls.push(work.command.kind)
                  return {}
                }),
            }),
          ),
        ),
      ),
    )
  }),
)

it.effect("atomically commits the registry and operation result, rolling both back on failure", () =>
  Effect.gen(function* () {
    const store = yield* MarketplaceOperationStore.Service
    const registry = yield* MarketplaceRegistry.Service
    const operation = yield* store.enqueue({
      request_id: "commit",
      location,
      command: { kind: "source-toggle", id: "source", enabled: true },
    })
    yield* store.claimNext()
    yield* store.advance(operation.id, { type: "phase-changed", phase: "applying", at: 1 })
    const state = { revision: 0, sources: [{ id: "source", name: "Source", url: "https://example.test/catalog.json" }] }
    const rollback = yield* registry
      .replace(state, (tx, result) =>
        store
          .completeWithin(tx, operation.id, { revision: result.state.revision, changed: result.changed })
          .pipe(Effect.andThen(Effect.die("after settlement"))),
      )
      .pipe(Effect.exit)
    expect(rollback._tag).toBe("Failure")
    expect((yield* registry.read()).revision).toBe(0)
    expect((yield* store.get(operation.id)).status).toBe("running")
    yield* registry.replace(state, (tx, result) =>
      store.completeWithin(tx, operation.id, { revision: result.state.revision, changed: result.changed }),
    )
    expect((yield* registry.read()).revision).toBe(1)
    expect(yield* store.get(operation.id)).toMatchObject({
      status: "succeeded",
      result: { revision: 1, changed: true },
    })
    expect(yield* store.interruptActive()).toBe(0)
    yield* store.warn(operation.id, "Configuration refresh needs retry")
    expect(yield* store.get(operation.id)).toMatchObject({
      status: "succeeded",
      warnings: ["Configuration refresh needs retry"],
    })
  }),
)

it.effect("preserves domain failures and continues draining after a failed operation", () =>
  Effect.gen(function* () {
    const queue = yield* observe
    yield* Effect.gen(function* () {
      const operations = yield* MarketplaceOperations.Service
      const first = yield* operations.submit({ request_id: "bad", location, command: { kind: "refresh" } })
      const second = yield* operations.submit({ request_id: "good", location, command: { kind: "prune" } })
      expect(yield* until(queue, first.id, "failed")).toMatchObject({
        error: { code: "download", message: "HTTP 429", retryable: true },
      })
      yield* until(queue, second.id, "succeeded")
    }).pipe(
      Effect.provide(
        MarketplaceOperations.layer.pipe(
          Layer.provide(
            Layer.succeed(MarketplaceOperationRunner.Service, {
              run: (work) =>
                work.command.kind === "refresh"
                  ? Effect.fail({ code: "download", message: "HTTP 429", retryable: true })
                  : Effect.succeed({}),
            }),
          ),
        ),
      ),
    )
  }),
)
