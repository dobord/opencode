import { expect, test } from "bun:test"
import { transition } from "./logo-machine"

test("settles image loading once, so a late load cannot replace an error fallback", () => {
  expect(transition("loading", "loaded")).toBe("ready")
  expect(transition("loading", "failed")).toBe("failed")
  expect(transition("failed", "loaded")).toBe("failed")
  expect(transition("ready", "failed")).toBe("ready")
})
