import path from "path"
import { beforeEach, expect } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { MarketplaceOperation } from "@opencode/schema/marketplace-operation"
import { Location } from "@opencode/schema/location"
import { AbsolutePath } from "@opencode/schema/schema"
import { Database } from "../../src/database/database.js"
import { MarketplaceOperationStore } from "../../src/marketplace/operation-store.js"
import { testEffect } from "../lib/effect"

const layer = LayerNode.compile(LayerNode.group([Database.node, MarketplaceOperationStore.node]))
const it = testEffect(layer)
const location = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })

beforeEach(async () => {
  await Effect.runPromise(
    Database.Service.use((database) => database.db.run(sql`DELETE FROM marketplace_operation`).pipe(Effect.orDie)).pipe(
      Effect.provide(layer),
    ),
  )
})

it.effect("keeps admission durable and idempotent without exposing execution credentials", () =>
  Effect.gen(function* () {
    const store = yield* MarketplaceOperationStore.Service
    const command: MarketplaceOperation.Command = {
      kind: "source-add",
      url: "https://github.com/openai/plugins",
      headers: { Authorization: "private-test-token" },
    }
    const first = yield* store.enqueue({ request_id: "add-source", location, command })
    expect(yield* store.enqueue({ request_id: "add-source", location, command })).toEqual(first)
    expect(yield* store.list()).toEqual([first])
    expect(JSON.stringify(yield* store.get(first.id))).not.toContain("private-test-token")
    const database = yield* Database.Service
    const rows = yield* database.db.all<{ id: string; request_id: string }>(
      sql`SELECT id, request_id FROM marketplace_operation`,
    )
    expect(rows).toEqual([{ id: first.id, request_id: "add-source" }])
    const persisted = yield* MarketplaceOperationStore.Service.use((fresh) => fresh.get(first.id)).pipe(
      Effect.provide(layer),
    )
    expect(persisted).toEqual(first)
    const work = yield* store.claimNext()
    expect(work?.command).toEqual(command)
    expect(work?.operation).toMatchObject({ id: first.id, status: "running", version: 1 })
  }),
)

it.effect("normalizes omitted optional properties when matching retried admission", () =>
  Effect.gen(function* () {
    const store = yield* MarketplaceOperationStore.Service
    const first = yield* store.enqueue({
      request_id: "same",
      location,
      command: { kind: "source-add", url: "https://example.test/catalog.json" },
    })
    expect(
      yield* store.enqueue({
        request_id: "same",
        location: { ...location, workspaceID: undefined },
        command: { kind: "source-add", url: "https://example.test/catalog.json", name: undefined, headers: undefined },
      }),
    ).toEqual(first)
  }),
)

it.effect("rejects reuse of an idempotency key for a different command or location", () =>
  Effect.gen(function* () {
    const store = yield* MarketplaceOperationStore.Service
    yield* store.enqueue({ request_id: "same", location, command: { kind: "refresh" } })
    const changedCommand = yield* store
      .enqueue({ request_id: "same", location, command: { kind: "prune" } })
      .pipe(Effect.result)
    const changedLocation = yield* store
      .enqueue({
        request_id: "same",
        location: Location.Ref.make({ directory: AbsolutePath.make(path.join(process.cwd(), "other")) }),
        command: { kind: "refresh" },
      })
      .pipe(Effect.result)
    expect(changedCommand._tag).toBe("Failure")
    expect(changedLocation._tag).toBe("Failure")
    expect(yield* store.list()).toHaveLength(1)
  }),
)

it.effect("claims work in admission order and permits only one global mutation at a time", () =>
  Effect.gen(function* () {
    const store = yield* MarketplaceOperationStore.Service
    const first = yield* store.enqueue({ request_id: "first", location, command: { kind: "refresh" } })
    const second = yield* store.enqueue({ request_id: "second", location, command: { kind: "prune" } })
    const running = yield* store.claimNext()
    if (!running) throw new Error("Expected queued operation")
    expect(running.operation.id).toBe(first.id)
    expect(yield* store.claimNext()).toBeUndefined()
    const finished = yield* store.update(first.id, running.operation.version, {
      type: "succeeded",
      result: { changed: false },
      at: 10,
    })
    expect(finished.status).toBe("succeeded")
    expect((yield* store.claimNext())?.operation.id).toBe(second.id)
    expect(yield* store.enqueue({ request_id: "first", location, command: { kind: "refresh" } })).toEqual(finished)
  }),
)

it.effect("protects persisted state from stale updates", () =>
  Effect.gen(function* () {
    const store = yield* MarketplaceOperationStore.Service
    const initial = yield* store.enqueue({ request_id: "first", location, command: { kind: "refresh" } })
    const claimed = yield* store.claimNext()
    if (!claimed) throw new Error("Expected running operation")
    const changed = yield* store.update(initial.id, claimed.operation.version, {
      type: "phase-changed",
      phase: "checking-source",
      at: 1,
    })
    const stale = yield* store
      .update(initial.id, claimed.operation.version, {
        type: "failed",
        error: { code: "internal", message: "late", retryable: true },
        at: 2,
      })
      .pipe(Effect.result)
    expect(stale._tag).toBe("Failure")
    expect(yield* store.get(initial.id)).toEqual(changed)
  }),
)

it.effect("cancels queued work without executing it and retains active cancellation until settled", () =>
  Effect.gen(function* () {
    const store = yield* MarketplaceOperationStore.Service
    const first = yield* store.enqueue({ request_id: "first", location, command: { kind: "refresh" } })
    const second = yield* store.enqueue({ request_id: "second", location, command: { kind: "prune" } })
    yield* store.update(first.id, 0, { type: "cancel-requested", at: 1 })
    const claimed = yield* store.claimNext()
    if (!claimed) throw new Error("Expected second operation")
    expect(claimed.operation.id).toBe(second.id)
    const cancelling = yield* store.update(second.id, claimed.operation.version, { type: "cancel-requested", at: 2 })
    expect(cancelling.status).toBe("cancelling")
    expect(yield* store.claimNext()).toBeUndefined()
    expect((yield* store.update(second.id, cancelling.version, { type: "cancelled", at: 3 })).status).toBe("cancelled")
  }),
)

it.effect("marks only active work interrupted on recovery and preserves queued and terminal results", () =>
  Effect.gen(function* () {
    const store = yield* MarketplaceOperationStore.Service
    const first = yield* store.enqueue({ request_id: "first", location, command: { kind: "refresh" } })
    const second = yield* store.enqueue({ request_id: "second", location, command: { kind: "prune" } })
    yield* store.claimNext()
    expect(yield* store.interruptActive()).toBe(1)
    expect((yield* store.get(first.id)).status).toBe("interrupted")
    expect((yield* store.get(second.id)).status).toBe("queued")
    expect(yield* store.interruptActive()).toBe(0)
    expect((yield* store.claimNext())?.operation.id).toBe(second.id)
  }),
)

it.effect("serializes simultaneous duplicate admission and competing worker claims", () =>
  Effect.gen(function* () {
    const store = yield* MarketplaceOperationStore.Service
    const input: MarketplaceOperationStore.Admission = {
      request_id: "concurrent",
      location,
      command: { kind: "refresh" },
    }
    const admitted = yield* Effect.all([store.enqueue(input), store.enqueue(input)], { concurrency: "unbounded" })
    expect(admitted[0].id).toBe(admitted[1].id)
    yield* store.enqueue({ request_id: "second", location, command: { kind: "prune" } })
    const claimed = yield* Effect.all([store.claimNext(), store.claimNext()], { concurrency: "unbounded" })
    expect(claimed.filter((work) => work !== undefined)).toHaveLength(1)
    expect((yield* store.list()).map((operation) => operation.status)).toEqual(["running", "queued"])
  }),
)
