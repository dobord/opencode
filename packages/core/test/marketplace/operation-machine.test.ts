import { describe, expect, test } from "bun:test"
import { MarketplaceOperation } from "@opencode/schema/marketplace-operation"
import { Location } from "@opencode/schema/location"
import { AbsolutePath } from "@opencode/schema/schema"
import { MarketplaceOperationMachine } from "../../src/marketplace/operation-machine.js"

function queued(): MarketplaceOperation.Info {
  return {
    id: MarketplaceOperation.ID.create(),
    kind: "install",
    target: "source:catalog:package",
    location: Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) }),
    version: 0,
    created_at: 0,
    updated_at: 0,
    status: "queued",
  }
}

describe("Marketplace operation lifecycle", () => {
  test("tracks durable phases and final result without retaining active-only fields", () => {
    const initial = queued()
    const running = MarketplaceOperationMachine.transition(initial, { type: "started", at: 1 })
    const materializing = MarketplaceOperationMachine.transition(running, {
      type: "phase-changed",
      phase: "materializing",
      progress: { completed: 9, total: 23, unit: "files" },
      at: 2,
    })
    const applying = MarketplaceOperationMachine.transition(materializing, {
      type: "phase-changed",
      phase: "applying",
      at: 3,
    })
    const result = MarketplaceOperationMachine.transition(applying, {
      type: "succeeded",
      result: { revision: 12, changed: true },
      at: 4,
    })
    expect(materializing).toMatchObject({
      status: "running",
      phase: "materializing",
      progress: { completed: 9, total: 23 },
      version: 2,
    })
    expect(applying).not.toHaveProperty("progress")
    expect(result).toEqual({
      id: initial.id,
      kind: initial.kind,
      target: initial.target,
      location: initial.location,
      created_at: 0,
      started_at: 1,
      updated_at: 4,
      finished_at: 4,
      version: 4,
      status: "succeeded",
      result: { revision: 12, changed: true },
    })
    expect(MarketplaceOperationMachine.active(result)).toBe(false)
  })

  test("cancels queued work without starting it", () => {
    const cancelled = MarketplaceOperationMachine.transition(queued(), { type: "cancel-requested", at: 1 })
    expect(cancelled).toMatchObject({ status: "cancelled", version: 1, finished_at: 1 })
    expect(cancelled).not.toHaveProperty("started_at")
    expect(MarketplaceOperationMachine.transition(cancelled, { type: "started", at: 2 })).toBe(cancelled)
  })

  test("does not report cancellation before execution cleanup settles", () => {
    const running = MarketplaceOperationMachine.transition(queued(), { type: "started", at: 1 })
    const cancelling = MarketplaceOperationMachine.transition(running, { type: "cancel-requested", at: 2 })
    expect(cancelling.status).toBe("cancelling")
    expect(MarketplaceOperationMachine.active(cancelling)).toBe(true)
    expect(MarketplaceOperationMachine.cancellable(cancelling)).toBe(false)
    expect(
      MarketplaceOperationMachine.transition(cancelling, { type: "phase-changed", phase: "downloading", at: 3 }),
    ).toBe(cancelling)
    expect(MarketplaceOperationMachine.transition(cancelling, { type: "cancelled", at: 4 })).toMatchObject({
      status: "cancelled",
      finished_at: 4,
      version: 3,
    })
  })

  test.each(["applying", "refreshing-config"] as const)("does not interrupt the commit boundary %s", (phase) => {
    const running = MarketplaceOperationMachine.transition(queued(), { type: "started", at: 1 })
    const applying = MarketplaceOperationMachine.transition(running, { type: "phase-changed", phase, at: 2 })
    expect(MarketplaceOperationMachine.cancellable(applying)).toBe(false)
    expect(MarketplaceOperationMachine.transition(applying, { type: "cancel-requested", at: 3 })).toBe(applying)
  })

  test("accepts committed completion that wins a late cancellation", () => {
    const running = MarketplaceOperationMachine.transition(queued(), { type: "started", at: 1 })
    const cancelling = MarketplaceOperationMachine.transition(running, { type: "cancel-requested", at: 2 })
    expect(
      MarketplaceOperationMachine.transition(cancelling, { type: "succeeded", result: { revision: 1 }, at: 3 }),
    ).toMatchObject({ status: "succeeded", result: { revision: 1 } })
  })

  test.each(["succeeded", "failed", "cancelled", "interrupted"] as const)(
    "ignores stale progress and terminal events after %s",
    (status) => {
      const running = MarketplaceOperationMachine.transition(queued(), { type: "started", at: 1 })
      const terminal =
        status === "succeeded"
          ? MarketplaceOperationMachine.transition(running, { type: "succeeded", result: {}, at: 2 })
          : status === "failed"
            ? MarketplaceOperationMachine.transition(running, {
                type: "failed",
                error: { code: "download", message: "HTTP 429", retryable: true },
                at: 2,
              })
            : status === "interrupted"
              ? MarketplaceOperationMachine.transition(running, { type: "interrupted", at: 2 })
              : MarketplaceOperationMachine.transition(
                  MarketplaceOperationMachine.transition(running, { type: "cancel-requested", at: 2 }),
                  { type: "cancelled", at: 3 },
                )
      expect(terminal.status).toBe(status)
      const events: MarketplaceOperationMachine.Event[] = [
        { type: "phase-changed", phase: "downloading", at: 9 },
        { type: "started", at: 9 },
        { type: "cancel-requested", at: 9 },
        { type: "succeeded", result: {}, at: 9 },
      ]
      events.forEach((event) => expect(MarketplaceOperationMachine.transition(terminal, event)).toBe(terminal))
    },
  )
})
