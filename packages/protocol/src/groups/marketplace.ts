import { Marketplace } from "@opencode/schema/marketplace"
import { MarketplaceOperation } from "@opencode/schema/marketplace-operation"
import { ConflictError, InvalidRequestError, ServiceUnavailableError } from "../errors.js"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

const root = "/api/experimental/marketplace"
const description = "Experimental: may change without compatibility guarantees."

export const MarketplaceGroup = HttpApiGroup.make("server.experimental.marketplace")
  .add(
    HttpApiEndpoint.get("marketplace.snapshot", `${root}/snapshot`, {
      query: LocationQuery,
      success: Marketplace.View,
      error: ServiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.marketplace.snapshot",
          summary: "Read cached Marketplace state without network access",
          description,
        }),
      ),
    HttpApiEndpoint.post("marketplace.operations.create", `${root}/operations`, {
      query: LocationQuery,
      payload: MarketplaceOperation.Submit,
      success: MarketplaceOperation.Info.annotate({ httpApiStatus: 202 }),
      error: [ConflictError, ServiceUnavailableError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.marketplace.operations.create",
          summary: "Queue a Marketplace operation",
          description,
        }),
      ),
    HttpApiEndpoint.get("marketplace.operations.list", `${root}/operations`, {
      query: LocationQuery,
      success: Schema.Array(MarketplaceOperation.Info),
      error: ServiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.marketplace.operations.list",
          summary: "List Marketplace operations",
          description,
        }),
      ),
    HttpApiEndpoint.get("marketplace.operations.get", `${root}/operations/:id`, {
      query: LocationQuery,
      params: { id: MarketplaceOperation.ID },
      success: MarketplaceOperation.Info,
      error: [InvalidRequestError, ServiceUnavailableError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.marketplace.operations.get",
          summary: "Get a Marketplace operation",
          description,
        }),
      ),
    HttpApiEndpoint.post("marketplace.operations.cancel", `${root}/operations/:id/cancel`, {
      query: LocationQuery,
      params: { id: MarketplaceOperation.ID },
      success: MarketplaceOperation.Info,
      error: [InvalidRequestError, ServiceUnavailableError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.marketplace.operations.cancel",
          summary: "Cancel a Marketplace operation",
          description,
        }),
      ),
    HttpApiEndpoint.get("marketplace.get", root, {
      query: LocationQuery,
      success: Marketplace.View,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({ identifier: "experimental.marketplace.get", summary: "Get Marketplace", description }),
      ),
    HttpApiEndpoint.post("marketplace.refresh", `${root}/refresh`, {
      error: ServiceUnavailableError,
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
      error: ServiceUnavailableError,
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
      error: ServiceUnavailableError,
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
