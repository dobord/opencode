import { Schema } from "effect"
import { MarketplaceSchema } from "@opencode-ai/core/marketplace-schema"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

const root = "/marketplace"

export const MarketplacePaths = {
  get: root,
  refresh: `${root}/refresh`,
  plan: `${root}/plan`,
  install: `${root}/install`,
  updateAll: `${root}/update-all`,
  installed: `${root}/install/:key`,
  source: `${root}/source`,
  sourceItem: `${root}/source/:id`,
  profile: `${root}/profile`,
  cachePrune: `${root}/cache/prune`,
} as const

export const MarketplaceApi = HttpApi.make("marketplace").add(
  HttpApiGroup.make("marketplace")
    .add(
      HttpApiEndpoint.get("get", MarketplacePaths.get, {
        success: described(MarketplaceSchema.View, "Marketplace state and catalog"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "marketplace.get",
          summary: "Get Marketplace",
          description: "Get local Marketplace state, cached catalogs, and cache statistics.",
        }),
      ),
      HttpApiEndpoint.post("refresh", MarketplacePaths.refresh, {
        success: described(MarketplaceSchema.View, "Refreshed Marketplace"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "marketplace.refresh",
          summary: "Refresh Marketplace",
          description: "Revalidate enabled catalog sources and return the current Marketplace view.",
        }),
      ),
      HttpApiEndpoint.post("plan", MarketplacePaths.plan, {
        payload: MarketplaceSchema.PlanInput,
        success: described(MarketplaceSchema.PlanResult, "Marketplace install plan"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "marketplace.plan",
          summary: "Plan Marketplace install",
          description: "Preview trust requirements, permissions, and configuration conflicts.",
        }),
      ),
      HttpApiEndpoint.post("install", MarketplacePaths.install, {
        payload: MarketplaceSchema.InstallInput,
        success: described(MarketplaceSchema.MutationResult, "Marketplace install result"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "marketplace.install",
          summary: "Install Marketplace item",
          description: "Materialize and install a Marketplace item using revision-based concurrency control.",
        }),
      ),
      HttpApiEndpoint.post("updateAll", MarketplacePaths.updateAll, {
        payload: MarketplaceSchema.UpdateAllInput,
        success: described(MarketplaceSchema.MutationResult, "Marketplace update result"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "marketplace.updateAll",
          summary: "Update Marketplace items",
          description: "Atomically update all available Marketplace items.",
        }),
      ),
      HttpApiEndpoint.delete("uninstall", MarketplacePaths.installed, {
        params: { key: Schema.String },
        payload: MarketplaceSchema.RevisionInput,
        success: described(MarketplaceSchema.MutationResult, "Marketplace uninstall result"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "marketplace.uninstall",
          summary: "Uninstall Marketplace item",
          description: "Remove an installed Marketplace item without rewriting user configuration.",
        }),
      ),
      HttpApiEndpoint.patch("toggle", MarketplacePaths.installed, {
        params: { key: Schema.String },
        payload: MarketplaceSchema.ToggleInput,
        success: described(MarketplaceSchema.MutationResult, "Marketplace component toggle result"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "marketplace.toggle",
          summary: "Toggle Marketplace component",
          description: "Enable or disable a package, skill, or MCP server.",
        }),
      ),
      HttpApiEndpoint.post("sourceAdd", MarketplacePaths.source, {
        payload: MarketplaceSchema.SourceAddInput,
        success: described(MarketplaceSchema.MutationResult, "Marketplace source result"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "marketplace.sourceAdd",
          summary: "Add Marketplace source",
          description: "Add or replace a Marketplace catalog source.",
        }),
      ),
      HttpApiEndpoint.patch("sourceToggle", MarketplacePaths.sourceItem, {
        params: { id: Schema.String },
        payload: MarketplaceSchema.SourceToggleInput,
        success: described(MarketplaceSchema.MutationResult, "Marketplace source result"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "marketplace.sourceToggle",
          summary: "Toggle Marketplace source",
          description: "Enable or disable a Marketplace catalog source.",
        }),
      ),
      HttpApiEndpoint.delete("sourceRemove", MarketplacePaths.sourceItem, {
        params: { id: Schema.String },
        payload: MarketplaceSchema.RevisionInput,
        success: described(MarketplaceSchema.MutationResult, "Marketplace source result"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "marketplace.sourceRemove",
          summary: "Remove Marketplace source",
          description: "Remove a source while keeping installed packages manageable.",
        }),
      ),
      HttpApiEndpoint.post("profileExport", MarketplacePaths.profile, {
        payload: MarketplaceSchema.ProfileExportInput,
        success: described(MarketplaceSchema.Profile, "Portable Marketplace profile"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "marketplace.profileExport",
          summary: "Export Marketplace profile",
          description: "Export a deterministic profile without credentials or local cache paths.",
        }),
      ),
      HttpApiEndpoint.post("cachePrune", MarketplacePaths.cachePrune, {
        payload: MarketplaceSchema.CachePruneInput,
        success: described(MarketplaceSchema.CacheSummary, "Marketplace cache summary"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "marketplace.cachePrune",
          summary: "Prune Marketplace cache",
          description: "Remove stale unreferenced content-addressed artifacts.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "marketplace",
        description: "Marketplace catalogs, installations, component state, profiles, and artifact cache.",
      }),
    ),
)
