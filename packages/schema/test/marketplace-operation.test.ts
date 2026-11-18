import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { MarketplaceOperation } from "../src/marketplace-operation.js"
import { Location } from "../src/location.js"
import { AbsolutePath } from "../src/schema.js"

describe("Marketplace operation contracts", () => {
  test("creates IDs matching the exact wire prefix", () => {
    const id = MarketplaceOperation.ID.create()
    expect(Schema.decodeUnknownSync(MarketplaceOperation.ID)(id)).toBe(id)
    for (const invalid of ["op_123", "mop", "mop_", "mop_invalid", "xmop_" + id.slice(4)])
      expect(() => Schema.decodeUnknownSync(MarketplaceOperation.ID)(invalid)).toThrow()
  })

  test("omits absent fields and keeps private command data out of public snapshots", () => {
    const info = Schema.encodeSync(MarketplaceOperation.Info)({
      id: MarketplaceOperation.ID.create(),
      kind: "refresh",
      status: "queued",
      version: 0,
      location: Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) }),
      created_at: 0,
      updated_at: 0,
    })
    expect(info).not.toHaveProperty("progress")
    expect(info).not.toHaveProperty("target")
    expect(info).not.toHaveProperty("outcomes")
    expect(info).not.toHaveProperty("warnings")
    expect(info).not.toHaveProperty("command")
    expect(info).not.toHaveProperty("started_at")
  })

  test("requires confirmation identity for install and supports progress without an invented total", () => {
    expect(() => Schema.decodeUnknownSync(MarketplaceOperation.Command)({ kind: "install", key: "package" })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(MarketplaceOperation.Command)({
        kind: "install",
        key: "package",
        expected_fingerprint: "",
      }),
    ).toThrow()
    expect(Schema.decodeUnknownSync(MarketplaceOperation.Progress)({ completed: 123, unit: "bytes" })).toEqual({
      completed: 123,
      unit: "bytes",
    })
    expect(() => Schema.decodeUnknownSync(MarketplaceOperation.Progress)({ completed: -1, unit: "files" })).toThrow()
  })
})
