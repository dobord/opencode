import { expect, test } from "bun:test"
import { MarketplaceOperation } from "@opencode/schema/marketplace-operation"
import { Schema } from "effect"
import { initial, pending, transition, view } from "./operations-machine"
import type { View } from "./machine"

const cached: View = {
  state: { revision: 1 },
  listings: [],
  errors: [],
  cache: { root: "cache", objects: 0, total_bytes: 0, fetch_entries: 0, materializations: 0 },
}
const operation = (status: "queued" | "succeeded", version: number) =>
  Schema.decodeUnknownSync(MarketplaceOperation.Info)({
    id: "mop_123456abcdef12345678901234",
    kind: "install",
    target: "package",
    location: { directory: "/project" },
    version,
    created_at: 1,
    updated_at: version,
    ...(status === "queued" ? { status } : { status, result: { revision: 2, changed: true }, finished_at: version }),
  })

test("merges reconnect snapshots without regressing a newer terminal event", () => {
  const loading = transition(initial(), { type: "load", location: { directory: "/project" } })
  const finished = transition(loading, { type: "updated", operation: operation("succeeded", 3) })
  const ready = transition(finished, {
    type: "loaded",
    attempt: loading.attempt,
    view: cached,
    operations: [operation("queued", 0)],
  })
  expect(ready.operations[operation("queued", 0).id].status).toBe("succeeded")
  expect(transition(ready, { type: "updated", operation: operation("queued", 1) })).toBe(ready)
  expect(view(ready)).toBe(cached)
})

test("claims a resource synchronously while leaving independent resources available", () => {
  const first = transition(initial(), { type: "submit", key: "package", id: "request", signature: "install:package" })
  expect(pending(first, "package")).toBe(true)
  expect(pending(first, "other")).toBe(false)
  expect(transition(first, { type: "submit", key: "package", id: "duplicate", signature: "install:package" })).toBe(
    first,
  )
  const second = transition(first, { type: "submit", key: "other", id: "independent", signature: "install:other" })
  const accepted = transition(second, {
    type: "accepted",
    key: "package",
    id: "request",
    operation: operation("queued", 0),
  })
  expect(accepted.requests.package).toBeUndefined()
  expect(pending(accepted, "package")).toBe(true)
  expect(pending(accepted, "other")).toBe(true)
  const complete = transition(accepted, { type: "updated", operation: operation("succeeded", 1) })
  expect(pending(complete, "package")).toBe(false)
})

test("rejects stale location loads and requests, retains failed request identity, and ignores disposal callbacks", () => {
  const first = transition(initial(), { type: "load", location: { directory: "/first" } })
  const second = transition(first, { type: "load", location: { directory: "/second" } })
  expect(transition(second, { type: "loaded", attempt: first.attempt, view: cached, operations: [] })).toBe(second)
  const submitted = transition(second, { type: "submit", key: "package", id: "stable-id", signature: "same-payload" })
  expect(transition(submitted, { type: "rejected", key: "package", id: "stale-id", error: "old" })).toBe(submitted)
  const failed = transition(submitted, { type: "rejected", key: "package", id: "stable-id", error: "connection lost" })
  expect(failed.requests.package).toEqual({
    status: "failed",
    id: "stable-id",
    signature: "same-payload",
    error: "connection lost",
  })
  expect(pending(failed, "package")).toBe(false)
  const disposed = transition(failed, { type: "disposed" })
  expect(transition(disposed, { type: "updated", operation: operation("succeeded", 1) })).toBe(disposed)
})
