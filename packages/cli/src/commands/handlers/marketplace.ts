import { Effect, Option, Schema } from "effect"
import { OpenCode } from "@opencode/client"
import { waitForMarketplaceOperation } from "@opencode/client/promise"
import type { MarketplaceOperation } from "@opencode/schema/marketplace-operation"
import { Service } from "@opencode/client/effect/service"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"

export default Runtime.handler(
  Commands.commands.marketplace,
  Effect.fn("cli.marketplace")(function* (input) {
    const connection = yield* ServerConnection.resolve()
    const api = OpenCode.make({ baseUrl: connection.endpoint.url, headers: Service.headers(connection.endpoint) })
    const client = api.experimental.marketplace
    const location = { directory: process.cwd() }
    const result = yield* Effect.tryPromise(async () => {
      const enabled = await client.operations.list({ location }).then(
        () => true,
        (error: unknown) => {
          if (
            Schema.is(Schema.Struct({ _tag: Schema.Literal("ServiceUnavailableError") }))(error) ||
            Schema.is(
              Schema.Struct({
                name: Schema.Literal("ClientError"),
                cause: Schema.Struct({ status: Schema.Literal(404) }),
              }),
            )(error)
          )
            return false
          throw error
        },
      )
      if (enabled) {
        const target = Option.getOrUndefined(input.target)
        const observe = (id: string) =>
          waitForMarketplaceOperation(api, id, location, (operation) => {
            const detail =
              operation.status === "running" || operation.status === "cancelling"
                ? `${operation.phase}${operation.progress ? ` ${operation.progress.completed}${operation.progress.total === undefined ? "" : `/${operation.progress.total}`} ${operation.progress.unit}` : ""}`
                : operation.status
            process.stderr.write(`${operation.id} ${operation.kind}: ${detail}\n`)
          })
        if (input.action === "list") return client.snapshot({ location })
        if (input.action === "profile") return client.profileExport({ location })
        if (input.action === "operations") return client.operations.list({ location })
        if (input.action === "observe" && target) return observe(target)
        if (input.action === "cancel" && target) return client.operations.cancel({ location, id: target })
        const submit = async (command: MarketplaceOperation.Command, detach = input.detach) => {
          const operation = await client.operations.create({ location, request_id: crypto.randomUUID(), command })
          process.stderr.write(`Marketplace operation: ${operation.id}\n`)
          return detach ? operation : observe(operation.id)
        }
        if (input.action === "refresh") return submit({ kind: "refresh" })
        if (input.action === "prune") return submit({ kind: "prune" })
        if (input.action === "update-all")
          return submit({ kind: "update-all", force: input.force, accept_untrusted: input.acceptUntrusted })
        if (!target) throw new Error("Marketplace target is required")
        if (input.action === "source-add") return submit({ kind: "source-add", url: target, trust: "community" })
        if (input.action === "source-remove") return submit({ kind: "source-remove", id: target })
        if (input.action === "source-toggle")
          return submit({ kind: "source-toggle", id: target, enabled: !input.disabled })
        if (input.action === "uninstall") return submit({ kind: "uninstall", key: target })
        if (input.action === "toggle")
          return submit({
            kind: "toggle",
            key: target,
            component: input.component,
            id: Option.getOrUndefined(input.id),
            enabled: !input.disabled,
          })
        if (input.action === "plan") return submit({ kind: "prepare-install", key: target })
        if (input.action === "install") {
          const fingerprint = Option.getOrUndefined(input.fingerprint)
          if (fingerprint)
            return submit({
              kind: "install",
              key: target,
              expected_fingerprint: fingerprint,
              force: input.force,
              accept_untrusted: input.acceptUntrusted,
            })
          const prepared = await submit({ kind: "prepare-install", key: target }, false)
          if (prepared.status !== "succeeded" || !prepared.result.fingerprint) return prepared
          return submit({
            kind: "install",
            key: target,
            expected_fingerprint: prepared.result.fingerprint,
            force: input.force,
            accept_untrusted: input.acceptUntrusted,
          })
        }
        throw new Error(`Unknown Marketplace action: ${input.action}`)
      }
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
    if ("status" in result && ["failed", "cancelled", "interrupted"].includes(result.status)) process.exitCode = 1
    if ("outcomes" in result && result.outcomes?.some((outcome) => outcome.status === "failed")) process.exitCode = 1
  }),
)
