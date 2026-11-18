import path from "node:path"
import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Config } from "@opencode/schema/config"
import { Marketplace } from "@opencode/schema/marketplace"
import { Plugin } from "@opencode/schema/plugin"
import { ensurePluginRuntime } from "@opencode/plugin/runtime"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"
import { eventually } from "../../core/test/lib/eventually"

ensurePluginRuntime()

it.live(
  "installs, toggles, and removes a catalog bundle through the current API without rewriting user config",
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("marketplace-api-")))
      const global = path.join(tmp.path, "global")
      const project = path.join(tmp.path, "project")
      const catalog = path.join(tmp.path, "catalog", "marketplace.json")
      const config = path.join(global, "opencode.jsonc")
      const original =
        '{\n  // preserve this comment\n  "snapshots": false,\n  "commands": { "marketplace_command": { "template": "User-owned command" } }\n}\n'
      yield* Effect.promise(async () => {
        await Bun.write(path.join(project, ".keep"), "")
        await Bun.write(config, original)
        await Bun.write(
          path.join(path.dirname(catalog), "plugin", "index.ts"),
          'import { Plugin } from "@opencode/plugin"\nimport { id } from "./id.ts"\nexport default Plugin.define({ id, setup() {} })\n',
        )
        await Bun.write(
          path.join(path.dirname(catalog), "plugin", "id.ts"),
          'export const id = "marketplace-api-probe"\n',
        )
        await Bun.write(
          catalog,
          JSON.stringify({
            schema: "opencode.marketplace/v1",
            id: "local",
            name: "Local",
            items: [
              {
                id: "bundle",
                name: "Bundle",
                description: "Local runtime projection",
                kind: "bundle",
                version: "1.0.0",
                install: {
                  plugins: ["./plugin/"],
                  agents: { marketplace_agent: { description: "Installed agent", mode: "subagent" } },
                  commands: { marketplace_command: { template: "Review changes" } },
                  mcp: { marketplace_docs: { type: "remote", url: "http://127.0.0.1:1/mcp", enabled: false } },
                },
              },
            ],
          }),
        )
      })
      const server = yield* startServer(global)
      const request = (route: string, method = "GET", payload?: unknown) =>
        Effect.promise(async () => {
          const url = new URL(route, server.base)
          url.searchParams.set("location[directory]", project)
          const response = await fetch(url, {
            method,
            headers: { ...server.headers, "content-type": "application/json" },
            body: payload === undefined ? undefined : JSON.stringify(payload),
          })
          const body: unknown = await response.json()
          expect(response.status).toBe(200)
          return body
        })
      const root = "/api/experimental/marketplace"
      const initial = Schema.decodeUnknownSync(Marketplace.View)(yield* request(root))
      const added = Schema.decodeUnknownSync(Marketplace.MutationResult)(
        yield* request(`${root}/source`, "POST", {
          expected_revision: initial.state.revision ?? 0,
          url: path.dirname(catalog),
        }),
      )
      expect(added.ok).toBe(true)
      if (!added.ok) throw new Error(added.message)
      const listing = added.view.listings.find((listing) => listing.item.id === "bundle")
      if (!listing) throw new Error("Local catalog bundle is missing")
      const preview = Schema.decodeUnknownSync(Marketplace.PlanResult)(
        yield* request(`${root}/plan`, "POST", { key: listing.key }),
      )
      expect(preview.ok && preview.conflicts.some((conflict) => conflict.path === "command.marketplace_command")).toBe(
        true,
      )
      const blocked = Schema.decodeUnknownSync(Marketplace.MutationResult)(
        yield* request(`${root}/install`, "POST", {
          expected_revision: added.view.state.revision,
          key: listing.key,
          force: true,
        }),
      )
      expect(blocked.ok).toBe(false)
      if (blocked.ok) throw new Error("Untrusted install must require explicit consent")
      expect(blocked.reason).toBe("trust")
      const installed = Schema.decodeUnknownSync(Marketplace.MutationResult)(
        yield* request(`${root}/install`, "POST", {
          expected_revision: added.view.state.revision,
          key: listing.key,
          accept_untrusted: true,
          force: true,
        }),
      )
      expect(installed.ok).toBe(true)
      if (!installed.ok) throw new Error(installed.message)
      const entries = Schema.decodeUnknownSync(Schema.Array(Config.Entry))(yield* request("/api/config"))
      const contribution = entries.findLast(
        (entry) => entry.type === "document" && entry.info.commands?.marketplace_command,
      )
      expect(contribution?.type).toBe("document")
      if (contribution?.type !== "document") throw new Error("Installed config contribution is missing")
      expect(contribution.info.agents?.marketplace_agent?.description).toBe("Installed agent")
      expect(contribution.info.commands?.marketplace_command?.template).toBe("Review changes")
      expect(contribution.info.plugins?.length).toBe(1)
      expect(contribution.info.mcp?.servers?.marketplace_docs?.disabled).toBe(true)
      const active = yield* eventually(
        request("/api/plugin").pipe(
          Effect.map(Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(Plugin.Info) }))),
          Effect.map((result) => result.data),
        ),
        (plugins) => {
          const failed = plugins.find((plugin) => plugin.source.type === "local" && plugin.state.status === "failed")
          if (failed?.state.status === "failed") throw new Error(failed.state.error)
          return plugins.some((plugin) => plugin.id === "marketplace-api-probe")
        },
      )
      expect(active.find((plugin) => plugin.id === "marketplace-api-probe")?.state.status).toBe("active")
      const stale = Schema.decodeUnknownSync(Marketplace.MutationResult)(
        yield* request(`${root}/install/${encodeURIComponent(listing.key)}`, "PATCH", {
          expected_revision: 0,
          component: "package",
          enabled: false,
        }),
      )
      expect(stale.ok).toBe(false)
      const disabled = Schema.decodeUnknownSync(Marketplace.MutationResult)(
        yield* request(`${root}/install/${encodeURIComponent(listing.key)}`, "PATCH", {
          expected_revision: installed.view.state.revision,
          component: "package",
          enabled: false,
        }),
      )
      expect(disabled.ok).toBe(true)
      if (!disabled.ok) throw new Error(disabled.message)
      const after = Schema.decodeUnknownSync(Schema.Array(Config.Entry))(yield* request("/api/config"))
      const restored = after.findLast((entry) => entry.type === "document" && entry.info.commands?.marketplace_command)
      expect(restored?.type === "document" && restored.info.commands?.marketplace_command?.template).toBe(
        "User-owned command",
      )
      yield* eventually(
        request("/api/plugin").pipe(
          Effect.map(Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(Plugin.Info) }))),
          Effect.map((result) => result.data),
        ),
        (plugins) => !plugins.some((plugin) => plugin.id === "marketplace-api-probe"),
      )
      const removed = Schema.decodeUnknownSync(Marketplace.MutationResult)(
        yield* request(`${root}/install/${encodeURIComponent(listing.key)}`, "DELETE", {
          expected_revision: disabled.view.state.revision,
        }),
      )
      expect(removed.ok).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(config).text())).toBe(original)
    }),
  // Boots the real server and Location/plugin graph, then exercises nine HTTP requests and SQLite mutations.
  { timeout: 30_000 },
)
