export * as MarketplaceOperationRunner from "./operation-runner.js"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import type { MarketplaceOperation } from "@opencode/schema/marketplace-operation"
import { LocationServiceMap } from "../location-service-map.js"
import { MarketplaceService } from "./service.js"
import type { MarketplaceOperationStore } from "./operation-store.js"

export class Service extends Context.Service<
  Service,
  {
    readonly run: (
      work: MarketplaceOperationStore.Work,
    ) => Effect.Effect<MarketplaceOperation.Result, MarketplaceOperation.Failure>
  }
>()("@opencode/MarketplaceOperationRunner") {}

export const node = makeGlobalNode({
  service: Service,
  deps: [LocationServiceMap.node],
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      const locations = yield* LocationServiceMap.Service
      return Service.of({
        run: (work) =>
          Effect.gen(function* () {
            const result = yield* MarketplaceService.Service.use((service) =>
              service.execute(work.command).pipe(Effect.result),
            ).pipe(
              Effect.provide(locations.get(work.operation.location)),
              Effect.catch(() =>
                Effect.fail({
                  code: "internal" as const,
                  message: "Marketplace Location is unavailable",
                  retryable: true,
                }),
              ),
            )
            if (result._tag === "Failure") return yield* Effect.fail(result.failure)
            return result.success
          }),
      })
    }),
  ),
})
