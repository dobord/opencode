import { Effect, Option } from "effect"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"

export default Runtime.handler(
  Commands.commands.marketplace,
  Effect.fn("cli.marketplace")(function* (input) {
    const connection = yield* ServerConnection.resolve()
    const client = OpenCode.make({ baseUrl: connection.endpoint.url, headers: Service.headers(connection.endpoint) })
      .experimental.marketplace
    const location = { directory: process.cwd() }
    const result = yield* Effect.tryPromise(async () => {
      if (input.action === "list") return client.get({ location })
      if (input.action === "refresh") return client.refresh({ location })
      if (input.action === "profile") return client.profileExport({ location })
      if (input.action === "prune") return client.cachePrune({ location })
      const target = Option.getOrUndefined(input.target)
      if (input.action === "plan") {
        if (!target) throw new Error("Marketplace item key is required")
        return client.plan({ location, key: target })
      }
      const view = await client.get({ location })
      const expected_revision = view.state.revision ?? 0
      if (input.action === "update-all")
        return client.updateAll({
          location,
          expected_revision,
          force: input.force,
          accept_untrusted: input.acceptUntrusted,
        })
      if (!target) throw new Error("Marketplace target is required")
      if (input.action === "install")
        return client.install({
          location,
          key: target,
          expected_revision,
          force: input.force,
          accept_untrusted: input.acceptUntrusted,
        })
      if (input.action === "uninstall") return client.uninstall({ location, key: target, expected_revision })
      if (input.action === "toggle")
        return client.toggle({
          location,
          key: target,
          expected_revision,
          component: input.component,
          id: Option.getOrUndefined(input.id),
          enabled: !input.disabled,
        })
      if (input.action === "source-add")
        return client.sourceAdd({ location, expected_revision, url: target, trust: "community" })
      if (input.action === "source-remove") return client.sourceRemove({ location, expected_revision, id: target })
      if (input.action === "source-toggle")
        return client.sourceToggle({ location, expected_revision, id: target, enabled: !input.disabled })
      throw new Error(`Unknown Marketplace action: ${input.action}`)
    })
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    if ("ok" in result && !result.ok) process.exitCode = 1
  }),
)
