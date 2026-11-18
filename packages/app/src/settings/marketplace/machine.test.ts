import { expect, test } from "bun:test"
import { busy, transition, type State, type View } from "./machine"

test("serializes requests and ignores late results after failure, retry, and disposal", () => {
  const view: View = {
    state: { revision: 1 },
    listings: [],
    errors: [],
    cache: { root: "cache", objects: 0, total_bytes: 0, fetch_entries: 0, materializations: 0 },
  }
  const started = transition({ status: "idle", attempt: 0 }, { type: "start" })
  expect(busy(started)).toBe(true)
  expect(transition(started, { type: "start" })).toBe(started)
  const failed = transition(started, { type: "failed", attempt: 1, error: "timeout" })
  expect(busy(failed)).toBe(false)
  const retried = transition(failed, { type: "start" })
  expect(transition(retried, { type: "loaded", attempt: 1, view })).toBe(retried)
  const ready = transition(retried, { type: "loaded", attempt: 2, view })
  expect(ready.view).toBe(view)
  const confirming: State = {
    status: "confirming",
    attempt: 2,
    view,
    listing: {
      key: "bundle",
      source: { id: "local", name: "Local", url: "file:///catalog.json" },
      catalog: { schema: "opencode.marketplace/v1", id: "local", name: "Local", items: [] },
      item: { id: "bundle", name: "Bundle", description: "Bundle", kind: "bundle", version: "1", install: {} },
    },
    plan: {
      ok: true,
      key: "bundle",
      action: "install",
      trust_warning: true,
      conflicts: [],
      permissions: [],
      summary: "Install",
    },
  }
  expect(transition(confirming, { type: "cancel" }).status).toBe("idle")
  const disposed = transition(retried, { type: "disposed" })
  expect(transition(disposed, { type: "loaded", attempt: 2, view })).toBe(disposed)
})
