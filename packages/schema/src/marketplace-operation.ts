export * as MarketplaceOperation from "./marketplace-operation.js"

import { Schema } from "effect"
import { ascending } from "./identifier.js"
import { Location } from "./location.js"
import { Marketplace } from "./marketplace.js"
import { NonNegativeInt, optional, statics } from "./schema.js"
import { ephemeral, inventory } from "./event.js"

export const ID = Schema.String.check(Schema.isPattern(/^mop_[0-9a-f]{12}[0-9A-Za-z]{14}$/u)).pipe(
  Schema.brand("MarketplaceOperation.ID"),
  Schema.annotate({ identifier: "MarketplaceOperation.ID" }),
  statics((schema) => ({ create: () => schema.make("mop_" + ascending()) })),
)
export type ID = typeof ID.Type

export const RequestID = Schema.String.check(Schema.isMinLength(1)).annotate({
  identifier: "MarketplaceOperation.RequestID",
})
export type RequestID = typeof RequestID.Type

export const Kind = Schema.Literals([
  "source-add",
  "source-remove",
  "source-toggle",
  "refresh",
  "prepare-install",
  "install",
  "uninstall",
  "update-all",
  "toggle",
  "prune",
])
export type Kind = typeof Kind.Type

const consent = { force: optional(Schema.Boolean), accept_untrusted: optional(Schema.Boolean) }

/** Private execution input. Never include this in a public operation snapshot: source headers may contain credentials. */
export const Command = Schema.Union([
  Schema.Struct({
    kind: Schema.tag("source-add"),
    url: Schema.String,
    name: optional(Schema.String),
    trust: optional(Marketplace.ConfiguredTrust),
    headers: optional(Schema.Record(Schema.String, Schema.String)),
  }),
  Schema.Struct({ kind: Schema.tag("source-remove"), id: Schema.String }),
  Schema.Struct({ kind: Schema.tag("source-toggle"), id: Schema.String, enabled: Schema.Boolean }),
  Schema.Struct({ kind: Schema.tag("refresh") }),
  Schema.Struct({ kind: Schema.tag("prepare-install"), key: Schema.String }),
  Schema.Struct({
    kind: Schema.tag("install"),
    key: Schema.String,
    expected_fingerprint: Schema.String.check(Schema.isMinLength(1)),
    ...consent,
  }),
  Schema.Struct({ kind: Schema.tag("uninstall"), key: Schema.String }),
  Schema.Struct({ kind: Schema.tag("update-all"), ...consent }),
  Schema.Struct({
    kind: Schema.tag("toggle"),
    key: Schema.String,
    component: Schema.Literals(["package", "skill", "mcp"]),
    id: optional(Schema.String),
    enabled: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.tag("prune"), max_age_days: optional(NonNegativeInt) }),
]).annotate({ identifier: "MarketplaceOperation.Command" })
export type Command = typeof Command.Type

export const Phase = Schema.Literals([
  "starting",
  "checking-source",
  "resolving",
  "checking-conflicts",
  "downloading",
  "materializing",
  "applying",
  "refreshing-config",
])
export type Phase = typeof Phase.Type

export interface Progress extends Schema.Schema.Type<typeof Progress> {}
export const Progress = Schema.Struct({
  completed: NonNegativeInt,
  total: optional(NonNegativeInt),
  unit: Schema.Literals(["bytes", "objects", "files", "packages"]),
}).annotate({ identifier: "MarketplaceOperation.Progress" })

export interface Result extends Schema.Schema.Type<typeof Result> {}
export const Result = Schema.Struct({
  revision: optional(NonNegativeInt),
  changed: optional(Schema.Boolean),
  connect_mcp: optional(Schema.Array(Schema.String)),
  plan: optional(Marketplace.PlanResult),
  fingerprint: optional(Schema.String),
}).annotate({ identifier: "MarketplaceOperation.Result" })

export interface Failure extends Schema.Schema.Type<typeof Failure> {}
export const Failure = Schema.Struct({
  code: Schema.Literals(["invalid-request", "conflict", "trust", "download", "not-found", "internal"]),
  message: Schema.String,
  retryable: Schema.Boolean,
}).annotate({ identifier: "MarketplaceOperation.Failure" })

export const PackageResult = Schema.Union([
  Schema.Struct({ key: Schema.String, status: Schema.tag("succeeded"), revision: NonNegativeInt }),
  Schema.Struct({ key: Schema.String, status: Schema.tag("failed"), error: Failure }),
]).annotate({ identifier: "MarketplaceOperation.PackageResult" })
export type PackageResult = typeof PackageResult.Type

const base = {
  id: ID,
  kind: Kind,
  target: optional(Schema.String),
  outcomes: optional(Schema.Array(PackageResult)),
  warnings: optional(Schema.Array(Schema.String)),
  location: Location.Ref,
  version: NonNegativeInt,
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
}
const active = { started_at: Schema.Finite, phase: Phase, progress: optional(Progress) }
const terminal = { started_at: optional(Schema.Finite), finished_at: Schema.Finite }

export const Info = Schema.Union([
  Schema.Struct({ ...base, status: Schema.tag("queued") }),
  Schema.Struct({ ...base, ...active, status: Schema.tag("running") }),
  Schema.Struct({ ...base, ...active, status: Schema.tag("cancelling") }),
  Schema.Struct({ ...base, ...terminal, status: Schema.tag("succeeded"), result: Result }),
  Schema.Struct({ ...base, ...terminal, status: Schema.tag("failed"), error: Failure }),
  Schema.Struct({ ...base, ...terminal, status: Schema.tag("cancelled") }),
  Schema.Struct({ ...base, ...terminal, status: Schema.tag("interrupted") }),
]).annotate({ identifier: "MarketplaceOperation.Info" })
export type Info = typeof Info.Type
export type Status = Info["status"]

export interface Submit extends Schema.Schema.Type<typeof Submit> {}
export const Submit = Schema.Struct({ request_id: RequestID, command: Command }).annotate({
  identifier: "MarketplaceOperation.Submit",
})

/** Current server event; snapshots are recoverable from the operations API. */
const Updated = ephemeral({ type: "marketplace.operation.updated", schema: { operation: Info } })
export const Event = { Updated, Definitions: inventory(Updated) }
