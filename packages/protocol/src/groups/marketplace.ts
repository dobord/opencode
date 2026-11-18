import { Marketplace } from "@opencode/schema/marketplace"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

const root = "/api/experimental/marketplace"
const description = "Experimental: may change without compatibility guarantees."

export const MarketplaceGroup = HttpApiGroup.make("server.experimental.marketplace")
  .add(
    HttpApiEndpoint.get("marketplace.get", root, {
      query: LocationQuery,
      success: Marketplace.View,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({ identifier: "experimental.marketplace.get", summary: "Get Marketplace", description }),
      ),
    HttpApiEndpoint.post("marketplace.refresh", `${root}/refresh`, {
      query: LocationQuery,
      success: Marketplace.View,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.marketplace.refresh",
          summary: "Refresh Marketplace",
          description,
        }),
      ),
    HttpApiEndpoint.post("marketplace.plan", `${root}/plan`, {
      query: LocationQuery,
      payload: Marketplace.PlanInput,
      success: Marketplace.PlanResult,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.marketplace.plan",
          summary: "Preview installation",
          description,
        }),
      ),
    HttpApiEndpoint.post("marketplace.install", `${root}/install`, {
      query: LocationQuery,
      payload: Marketplace.InstallInput,
      success: Marketplace.MutationResult,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({ identifier: "experimental.marketplace.install", summary: "Install item", description }),
      ),
    HttpApiEndpoint.post("marketplace.updateAll", `${root}/update-all`, {
      query: LocationQuery,
      payload: Marketplace.UpdateAllInput,
      success: Marketplace.MutationResult,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.marketplace.updateAll",
          summary: "Update installed items",
          description,
        }),
      ),
    HttpApiEndpoint.delete("marketplace.uninstall", `${root}/install/:key`, {
      query: LocationQuery,
      params: { key: Schema.String },
      payload: Marketplace.RevisionInput,
      success: Marketplace.MutationResult,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.marketplace.uninstall",
          summary: "Uninstall item",
          description,
        }),
      ),
    HttpApiEndpoint.patch("marketplace.toggle", `${root}/install/:key`, {
      query: LocationQuery,
      params: { key: Schema.String },
      payload: Marketplace.ToggleInput,
      success: Marketplace.MutationResult,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.marketplace.toggle",
          summary: "Toggle installed component",
          description,
        }),
      ),
    HttpApiEndpoint.post("marketplace.sourceAdd", `${root}/source`, {
      query: LocationQuery,
      payload: Marketplace.SourceAddInput,
      success: Marketplace.MutationResult,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.marketplace.sourceAdd",
          summary: "Add catalog source",
          description,
        }),
      ),
    HttpApiEndpoint.patch("marketplace.sourceToggle", `${root}/source/:id`, {
      query: LocationQuery,
      params: { id: Schema.String },
      payload: Marketplace.SourceToggleInput,
      success: Marketplace.MutationResult,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.marketplace.sourceToggle",
          summary: "Toggle catalog source",
          description,
        }),
      ),
    HttpApiEndpoint.delete("marketplace.sourceRemove", `${root}/source/:id`, {
      query: LocationQuery,
      params: { id: Schema.String },
      payload: Marketplace.RevisionInput,
      success: Marketplace.MutationResult,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.marketplace.sourceRemove",
          summary: "Remove catalog source",
          description,
        }),
      ),
    HttpApiEndpoint.post("marketplace.profileExport", `${root}/profile`, {
      query: LocationQuery,
      payload: Marketplace.ProfileExportInput,
      success: Marketplace.Profile,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.marketplace.profileExport",
          summary: "Export profile",
          description,
        }),
      ),
    HttpApiEndpoint.post("marketplace.cachePrune", `${root}/cache/prune`, {
      query: LocationQuery,
      payload: Marketplace.CachePruneInput,
      success: Marketplace.CacheSummary,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.marketplace.cachePrune",
          summary: "Prune unused artifacts",
          description,
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "marketplace", description }))
