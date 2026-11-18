export * as Marketplace from "./marketplace.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema.js"

export const Trust = Schema.Literals(["official", "verified", "community", "private"])
export const ConfiguredTrust = Schema.Literals(["community", "private"])
export const Kind = Schema.Literals(["plugin", "skill", "agent", "command", "mcp", "bundle"])

export const Source = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  reference: optional(Schema.String),
  enabled: optional(Schema.Boolean),
  trust: optional(Trust),
  headers: optional(Schema.Record(Schema.String, Schema.String)),
}).annotate({ identifier: "MarketplaceSource" })

export const Installed = Schema.Struct({
  source: Schema.String,
  source_url: optional(Schema.String),
  source_trust: optional(Trust),
  catalog: Schema.String,
  catalog_name: optional(Schema.String),
  item: Schema.String,
  name: Schema.String,
  kind: Kind,
  version: Schema.String,
  publisher: optional(Schema.String),
  fingerprint: Schema.String,
  installed_at: Schema.String,
  updated_at: Schema.String,
  snapshot: optional(Schema.Unknown),
  plan: Schema.Unknown,
  materialized_plan: optional(Schema.Unknown),
  active_plan: optional(Schema.Unknown),
  receipt: Schema.Unknown,
  enabled: optional(Schema.Boolean),
  disabled_skills: optional(Schema.Array(Schema.String)),
  disabled_mcp: optional(Schema.Array(Schema.String)),
  catalog_digest: optional(Schema.String),
  manifest_digest: optional(Schema.String),
  materialized_digest: optional(Schema.String),
  artifact_digests: optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "MarketplaceInstalled" })

export const State = Schema.Struct({
  revision: optional(NonNegativeInt),
  sources: optional(Schema.Array(Source)),
  installed: optional(Schema.Record(Schema.String, Installed)),
}).annotate({ identifier: "MarketplaceState" })

const Publisher = Schema.Struct({ name: Schema.String, url: optional(Schema.String) })
export const Skill = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: optional(Schema.String),
  path: optional(Schema.String),
  url: optional(Schema.String),
  enabled: optional(Schema.Boolean),
  files: optional(Schema.Record(Schema.String, Schema.String)),
})
export const InstallPlan = Schema.Struct({
  foreign: optional(
    Schema.Struct({
      format: Schema.Literals(["claude", "copilot", "codex"]),
      catalog_url: Schema.String,
      entry: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
  plugins: optional(
    Schema.Array(
      Schema.Union([Schema.String, Schema.Tuple([Schema.String, Schema.Record(Schema.String, Schema.Unknown)])]),
    ),
  ),
  skills: optional(
    Schema.Struct({
      paths: optional(Schema.Array(Schema.String)),
      urls: optional(Schema.Array(Schema.String)),
      items: optional(Schema.Array(Skill)),
    }),
  ),
  agents: optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown))),
  commands: optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown))),
  mcp: optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown))),
  instructions: optional(Schema.Array(Schema.String)),
})
export const Item = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  kind: Kind,
  version: Schema.String,
  publisher: optional(Publisher),
  homepage: optional(Schema.String),
  repository: optional(Schema.String),
  license: optional(Schema.String),
  tags: optional(Schema.Array(Schema.String)),
  featured: optional(Schema.Boolean),
  icon: optional(Schema.Struct({ "src-light": Schema.String, "src-dark": optional(Schema.String) })),
  brand_color: optional(Schema.String),
  permissions: optional(Schema.Array(Schema.String)),
  setup: optional(Schema.Array(Schema.String)),
  requires_restart: optional(Schema.Boolean),
  install: InstallPlan,
}).annotate({ identifier: "Marketplace.Item" })
export const Catalog = Schema.Struct({
  schema: Schema.Literal("opencode.marketplace/v1"),
  id: Schema.String,
  name: Schema.String,
  description: optional(Schema.String),
  items: Schema.Array(Item),
}).annotate({ identifier: "Marketplace.Catalog" })

export const Listing = Schema.Struct({
  key: Schema.String,
  source: Source,
  catalog: Catalog,
  item: Item,
  status: optional(Schema.Literals(["available", "installed", "update"])),
  orphaned: optional(Schema.Boolean),
  catalog_url: optional(Schema.String),
  catalog_digest: optional(Schema.String),
}).annotate({ identifier: "MarketplaceListing" })

export const LoadError = Schema.Struct({
  source: Source,
  message: Schema.String,
}).annotate({ identifier: "MarketplaceLoadError" })

export const CacheSummary = Schema.Struct({
  root: Schema.String,
  objects: NonNegativeInt,
  total_bytes: NonNegativeInt,
  fetch_entries: NonNegativeInt,
  materializations: NonNegativeInt,
}).annotate({ identifier: "MarketplaceCacheSummary" })

export interface SourceStatus extends Schema.Schema.Type<typeof SourceStatus> {}
export const SourceStatus = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["checking", "ready", "failed", "disabled"]),
  message: optional(Schema.String),
}).annotate({ identifier: "Marketplace.SourceStatus" })

export const View = Schema.Struct({
  source_status: optional(Schema.Array(SourceStatus)),
  state: State,
  listings: Schema.Array(Listing),
  errors: Schema.Array(LoadError),
  cache: CacheSummary,
}).annotate({ identifier: "MarketplaceView" })

export const Conflict = Schema.Struct({
  path: Schema.String,
  current: Schema.Unknown,
  incoming: Schema.Unknown,
}).annotate({ identifier: "MarketplaceConflict" })

export const PlanInput = Schema.Struct({
  key: Schema.String,
}).annotate({ identifier: "MarketplacePlanInput" })

export const PlanResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    key: Schema.String,
    action: Schema.Literals(["install", "update"]),
    trust_warning: Schema.Boolean,
    conflicts: Schema.Array(Conflict),
    permissions: Schema.Array(Schema.String),
    summary: Schema.String,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    reason: Schema.Literals(["not_found", "materialization"]),
    message: Schema.String,
  }),
]).annotate({ identifier: "MarketplacePlanResult" })

export const InstallInput = Schema.Struct({
  key: Schema.String,
  expected_revision: NonNegativeInt,
  force: optional(Schema.Boolean),
  accept_untrusted: optional(Schema.Boolean),
}).annotate({ identifier: "MarketplaceInstallInput" })

export const UpdateAllInput = Schema.Struct({
  expected_revision: NonNegativeInt,
  force: optional(Schema.Boolean),
  accept_untrusted: optional(Schema.Boolean),
}).annotate({ identifier: "MarketplaceUpdateAllInput" })

export const RevisionInput = Schema.Struct({
  expected_revision: NonNegativeInt,
}).annotate({ identifier: "MarketplaceRevisionInput" })

export const ToggleInput = Schema.Struct({
  expected_revision: NonNegativeInt,
  component: Schema.Literals(["package", "skill", "mcp"]),
  id: optional(Schema.String),
  enabled: Schema.Boolean,
}).annotate({ identifier: "MarketplaceToggleInput" })

export const SourceAddInput = Schema.Struct({
  expected_revision: NonNegativeInt,
  url: Schema.String,
  name: optional(Schema.String),
  trust: optional(ConfiguredTrust),
  headers: optional(Schema.Record(Schema.String, Schema.String)),
}).annotate({ identifier: "MarketplaceSourceAddInput" })

export const SourceToggleInput = Schema.Struct({
  expected_revision: NonNegativeInt,
  enabled: Schema.Boolean,
}).annotate({ identifier: "MarketplaceSourceToggleInput" })

export const ProfileExportInput = Schema.Struct({
  name: optional(Schema.String),
  description: optional(Schema.String),
}).annotate({ identifier: "MarketplaceProfileExportInput" })

export const CachePruneInput = Schema.Struct({
  max_age_days: optional(NonNegativeInt),
}).annotate({ identifier: "MarketplaceCachePruneInput" })

export const MutationResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    changed: Schema.Boolean,
    view: View,
    connect_mcp: Schema.Array(Schema.String),
    preserved: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    reason: Schema.Literals(["conflict", "revision", "trust", "not_found", "materialization"]),
    message: Schema.String,
    revision: optional(NonNegativeInt),
    conflicts: optional(Schema.Array(Conflict)),
  }),
]).annotate({ identifier: "MarketplaceMutationResult" })

const ProfileSource = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  trust: optional(Trust),
})

const ProfilePackage = Schema.Struct({
  key: Schema.String,
  source: Schema.String,
  catalog: Schema.String,
  item: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  version: Schema.String,
  enabled: Schema.Boolean,
  components: Schema.Struct({
    skills: Schema.Record(Schema.String, Schema.Boolean),
    mcp: Schema.Record(Schema.String, Schema.Boolean),
  }),
})

export const Profile = Schema.Struct({
  schema: Schema.Literal("opencode.marketplace.profile/v1"),
  name: Schema.String,
  description: optional(Schema.String),
  generated_at: Schema.String,
  sources: Schema.Array(ProfileSource),
  packages: Schema.Array(ProfilePackage),
}).annotate({ identifier: "MarketplaceProfile" })

export interface Source extends Schema.Schema.Type<typeof Source> {}
export type Trust = typeof Trust.Type
export type ConfiguredTrust = typeof ConfiguredTrust.Type
export type Kind = typeof Kind.Type
export interface Installed extends Schema.Schema.Type<typeof Installed> {}
export interface State extends Schema.Schema.Type<typeof State> {}
export interface Skill extends Schema.Schema.Type<typeof Skill> {}
export interface InstallPlan extends Schema.Schema.Type<typeof InstallPlan> {}
export interface Item extends Schema.Schema.Type<typeof Item> {}
export interface Catalog extends Schema.Schema.Type<typeof Catalog> {}
export interface Listing extends Schema.Schema.Type<typeof Listing> {}
export interface LoadError extends Schema.Schema.Type<typeof LoadError> {}
export interface CacheSummary extends Schema.Schema.Type<typeof CacheSummary> {}
export interface View extends Schema.Schema.Type<typeof View> {}
export interface Conflict extends Schema.Schema.Type<typeof Conflict> {}
export interface PlanInput extends Schema.Schema.Type<typeof PlanInput> {}
export type PlanResult = typeof PlanResult.Type
export interface InstallInput extends Schema.Schema.Type<typeof InstallInput> {}
export interface UpdateAllInput extends Schema.Schema.Type<typeof UpdateAllInput> {}
export interface RevisionInput extends Schema.Schema.Type<typeof RevisionInput> {}
export interface ToggleInput extends Schema.Schema.Type<typeof ToggleInput> {}
export interface SourceAddInput extends Schema.Schema.Type<typeof SourceAddInput> {}
export interface SourceToggleInput extends Schema.Schema.Type<typeof SourceToggleInput> {}
export interface ProfileExportInput extends Schema.Schema.Type<typeof ProfileExportInput> {}
export interface CachePruneInput extends Schema.Schema.Type<typeof CachePruneInput> {}
export type MutationResult = typeof MutationResult.Type
export interface Profile extends Schema.Schema.Type<typeof Profile> {}
