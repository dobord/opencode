import { MarketplaceService } from "@opencode/core/marketplace/service"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"

export const MarketplaceHandler = HttpApiBuilder.group(Api, "server.experimental.marketplace", (handlers) =>
  handlers
    .handle("marketplace.get", () => MarketplaceService.Service.use((service) => service.get()))
    .handle("marketplace.refresh", () => MarketplaceService.Service.use((service) => service.get({ refresh: true })))
    .handle("marketplace.plan", (ctx) => MarketplaceService.Service.use((service) => service.plan(ctx.payload.key)))
    .handle("marketplace.install", (ctx) =>
      MarketplaceService.Service.use((service) =>
        service.install({
          key: ctx.payload.key,
          expectedRevision: ctx.payload.expected_revision,
          force: ctx.payload.force,
          acceptUntrusted: ctx.payload.accept_untrusted,
        }),
      ),
    )
    .handle("marketplace.updateAll", (ctx) =>
      MarketplaceService.Service.use((service) =>
        service.updateAll({
          expectedRevision: ctx.payload.expected_revision,
          force: ctx.payload.force,
          acceptUntrusted: ctx.payload.accept_untrusted,
        }),
      ),
    )
    .handle("marketplace.uninstall", (ctx) =>
      MarketplaceService.Service.use((service) =>
        service.uninstall({
          key: ctx.params.key,
          expectedRevision: ctx.payload.expected_revision,
        }),
      ),
    )
    .handle("marketplace.toggle", (ctx) =>
      MarketplaceService.Service.use((service) =>
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
      MarketplaceService.Service.use((service) =>
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
      MarketplaceService.Service.use((service) =>
        service.sourceToggle({
          id: ctx.params.id,
          expectedRevision: ctx.payload.expected_revision,
          enabled: ctx.payload.enabled,
        }),
      ),
    )
    .handle("marketplace.sourceRemove", (ctx) =>
      MarketplaceService.Service.use((service) =>
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
      MarketplaceService.Service.use((service) => service.cachePrune({ maxAgeDays: ctx.payload.max_age_days })),
    ),
)
