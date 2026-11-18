import { MarketplaceService } from "@opencode/core/marketplace/service"
import { MarketplaceOperations } from "@opencode/core/marketplace/operations"
import { MarketplaceOperationStore } from "@opencode/core/marketplace/operation-store"
import { Location } from "@opencode/core/location"
import { Flag } from "@opencode/core/flag"
import { ConflictError, InvalidRequestError, ServiceUnavailableError } from "@opencode/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import type { Marketplace } from "@opencode/schema/marketplace"

export const MarketplaceHandler = HttpApiBuilder.group(Api, "server.experimental.marketplace", (handlers) =>
  handlers
    .handle("marketplace.snapshot", () =>
      enabled.pipe(Effect.andThen(MarketplaceService.Service.use((service) => service.get({ cached: true })))),
    )
    .handle("marketplace.operations.create", (ctx) =>
      Effect.gen(function* () {
        yield* enabled
        const location = yield* Location.Service
        const operations = yield* MarketplaceOperations.Service
        return yield* operations
          .submit({
            ...ctx.payload,
            location: Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }),
          })
          .pipe(
            Effect.catchTag("MarketplaceOperationConflict", (error) =>
              Effect.fail(new ConflictError({ message: error.message })),
            ),
          )
      }),
    )
    .handle("marketplace.operations.list", () =>
      enabled.pipe(Effect.andThen(MarketplaceOperationStore.Service.use((store) => store.list()))),
    )
    .handle("marketplace.operations.get", (ctx) =>
      enabled.pipe(
        Effect.andThen(MarketplaceOperationStore.Service.use((store) => store.get(ctx.params.id))),
        Effect.catchTag("MarketplaceOperationNotFound", () =>
          Effect.fail(new InvalidRequestError({ message: "Marketplace operation not found" })),
        ),
      ),
    )
    .handle("marketplace.operations.cancel", (ctx) =>
      enabled.pipe(
        Effect.andThen(MarketplaceOperations.Service.use((operations) => operations.cancel(ctx.params.id))),
        Effect.catchTag("MarketplaceOperationNotFound", () =>
          Effect.fail(new InvalidRequestError({ message: "Marketplace operation not found" })),
        ),
      ),
    )
    .handle("marketplace.get", () =>
      Effect.gen(function* () {
        const flags = yield* Flag.Service
        const service = yield* MarketplaceService.Service
        return yield* service.get({ cached: yield* flags.enabled("marketplace_operations") })
      }),
    )
    .handle("marketplace.refresh", () =>
      legacy.pipe(Effect.andThen(MarketplaceService.Service.use((service) => service.get({ refresh: true })))),
    )
    .handle("marketplace.plan", (ctx) =>
      legacy.pipe(Effect.andThen(MarketplaceService.Service.use((service) => service.plan(ctx.payload.key)))),
    )
    .handle("marketplace.install", (ctx) =>
      mutation((service) =>
        service.install({
          key: ctx.payload.key,
          expectedRevision: ctx.payload.expected_revision,
          force: ctx.payload.force,
          acceptUntrusted: ctx.payload.accept_untrusted,
        }),
      ),
    )
    .handle("marketplace.updateAll", (ctx) =>
      mutation((service) =>
        service.updateAll({
          expectedRevision: ctx.payload.expected_revision,
          force: ctx.payload.force,
          acceptUntrusted: ctx.payload.accept_untrusted,
        }),
      ),
    )
    .handle("marketplace.uninstall", (ctx) =>
      mutation((service) =>
        service.uninstall({
          key: ctx.params.key,
          expectedRevision: ctx.payload.expected_revision,
        }),
      ),
    )
    .handle("marketplace.toggle", (ctx) =>
      mutation((service) =>
        service.toggle({
          key: ctx.params.key,
          expectedRevision: ctx.payload.expected_revision,
          component: ctx.payload.component,
          id: ctx.payload.id,
          enabled: ctx.payload.enabled,
        }),
      ),
    )
    .handle("marketplace.sourceAdd", (ctx) =>
      mutation((service) =>
        service.sourceAdd({
          expectedRevision: ctx.payload.expected_revision,
          url: ctx.payload.url,
          name: ctx.payload.name,
          trust: ctx.payload.trust,
          headers: ctx.payload.headers,
        }),
      ),
    )
    .handle("marketplace.sourceToggle", (ctx) =>
      mutation((service) =>
        service.sourceToggle({
          id: ctx.params.id,
          expectedRevision: ctx.payload.expected_revision,
          enabled: ctx.payload.enabled,
        }),
      ),
    )
    .handle("marketplace.sourceRemove", (ctx) =>
      mutation((service) =>
        service.sourceRemove({
          id: ctx.params.id,
          expectedRevision: ctx.payload.expected_revision,
        }),
      ),
    )
    .handle("marketplace.profileExport", (ctx) =>
      MarketplaceService.Service.use((service) => service.profileExport(ctx.payload)),
    )
    .handle("marketplace.cachePrune", (ctx) =>
      legacy.pipe(
        Effect.andThen(
          MarketplaceService.Service.use((service) => service.cachePrune({ maxAgeDays: ctx.payload.max_age_days })),
        ),
      ),
    ),
)

const enabled = Effect.gen(function* () {
  const flags = yield* Flag.Service
  if (!(yield* flags.enabled("marketplace_operations")))
    return yield* new ServiceUnavailableError({
      message: "Enable marketplace_operations to use background Marketplace operations",
    })
})

const legacy = Effect.gen(function* () {
  const flags = yield* Flag.Service
  if (yield* flags.enabled("marketplace_operations"))
    return yield* new ServiceUnavailableError({ message: "Background Marketplace is enabled; use the operations API" })
})

const mutation = (run: (service: MarketplaceService.Interface) => Effect.Effect<Marketplace.MutationResult>) =>
  Effect.gen(function* () {
    const flags = yield* Flag.Service
    if (yield* flags.enabled("marketplace_operations"))
      return {
        ok: false as const,
        reason: "conflict" as const,
        message: "Background Marketplace is enabled; submit this action through the operations API",
      }
    const service = yield* MarketplaceService.Service
    return yield* run(service)
  })
