import path from "node:path"
import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Config } from "@opencode/schema/config"
import { Marketplace } from "@opencode/schema/marketplace"
import { MarketplaceOperation } from "@opencode/schema/marketplace-operation"
import { OpenCode, waitForMarketplaceOperation } from "@opencode/client/promise"
import { Plugin } from "@opencode/schema/plugin"
import { ensurePluginRuntime } from "@opencode/plugin/runtime"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"
import { eventually } from "../../core/test/lib/eventually"

ensurePluginRuntime()

it.live(
  "executes durable Marketplace operations and binds install consent to the prepared plan",
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("marketplace-operations-api-")))
      const global = path.join(tmp.path, "global")
      const project = path.join(tmp.path, "project")
      const catalog = path.join(tmp.path, "catalog", "marketplace.json")
      yield* Effect.promise(async () => {
        await Bun.write(path.join(project, ".keep"), "")
        await Bun.write(
          path.join(global, "opencode.json"),
          JSON.stringify({ experimental: { marketplace_operations: true } }),
        )
        await Bun.write(
          catalog,
          JSON.stringify({
            schema: "opencode.marketplace/v1",
            id: "local",
            name: "Local",
            items: [
              {
                id: "commands",
                name: "Commands",
                description: "Local commands",
                kind: "bundle",
                version: "1.0.0",
                install: { commands: { background_command: { template: "Hello" } } },
              },
              {
                id: "broken",
                name: "Broken",
                description: "Preserve this install on update failure",
                kind: "bundle",
                version: "1.0.0",
                install: { commands: { retained_command: { template: "Keep me" } } },
              },
            ],
          }),
        )
      })
      const server = yield* startServer(global)
      const root = "/api/experimental/marketplace"
      const request = (route: string, method = "GET", body?: unknown, status = 200) =>
        Effect.promise(async () => {
          const url = new URL(route, server.base)
          url.searchParams.set("location[directory]", project)
          const response = await fetch(url, {
            method,
            headers: { ...server.headers, "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
          const value: unknown = await response.json()
          expect(response.status).toBe(status)
          return value
        })
      const submit = (request_id: string, command: MarketplaceOperation.Command) =>
        request(`${root}/operations`, "POST", { request_id, command }, 202).pipe(
          Effect.map(Schema.decodeUnknownSync(MarketplaceOperation.Info)),
        )
      const complete = (id: MarketplaceOperation.ID) =>
        eventually(
          request(`${root}/operations/${id}`).pipe(Effect.map(Schema.decodeUnknownSync(MarketplaceOperation.Info))),
          (info) => info.status !== "queued" && info.status !== "running" && info.status !== "cancelling",
        )
      const admitted = yield* submit("source", { kind: "source-add", url: "../catalog" })
      const source = yield* complete(admitted.id)
      expect(source.status).toBe("succeeded")
      const snapshot = Schema.decodeUnknownSync(Marketplace.View)(yield* request(`${root}/snapshot`))
      expect(snapshot.source_status?.[0]?.status).toBe("ready")
      const bypass = Schema.decodeUnknownSync(Marketplace.MutationResult)(
        yield* request(`${root}/source`, "POST", { expected_revision: 1, url: "../bypass" }),
      )
      expect(bypass.ok).toBe(false)
      expect((yield* submit("source", { kind: "source-add", url: "../catalog" })).id).toBe(admitted.id)
      yield* request(`${root}/operations`, "POST", { request_id: "source", command: { kind: "refresh" } }, 409)
      const view = Schema.decodeUnknownSync(Marketplace.View)(yield* request(root))
      const key = view.listings.find((listing) => listing.item.id === "commands")?.key
      if (!key) throw new Error("Catalog listing missing")
      const prepared = yield* complete((yield* submit("plan", { kind: "prepare-install", key })).id)
      if (prepared.status !== "succeeded" || !prepared.result.fingerprint)
        throw new Error("Prepared installation fingerprint missing")
      const rejected = yield* complete(
        (yield* submit("stale", { kind: "install", key, expected_fingerprint: "stale", accept_untrusted: true })).id,
      )
      expect(rejected).toMatchObject({ status: "failed", error: { code: "conflict" } })
      const installed = yield* complete(
        (yield* submit("install", {
          kind: "install",
          key,
          expected_fingerprint: prepared.result.fingerprint,
          accept_untrusted: true,
        })).id,
      )
      expect(installed).toMatchObject({ status: "succeeded", result: { revision: 2, changed: true } })
      const observed = yield* Effect.tryPromise((signal) =>
        waitForMarketplaceOperation(
          OpenCode.make({ baseUrl: server.base, headers: server.headers }),
          installed.id,
          { directory: project },
          undefined,
          signal,
        ),
      )
      expect(observed.id).toBe(installed.id)
      const current = Schema.decodeUnknownSync(Marketplace.View)(yield* request(root))
      expect(current.state.installed?.[key]?.name).toBe("Commands")
      const history = Schema.decodeUnknownSync(Schema.Array(MarketplaceOperation.Info))(
        yield* request(`${root}/operations`),
      )
      expect(history.map((operation) => operation.status)).toEqual(["succeeded", "succeeded", "failed", "succeeded"])
      expect(
        Schema.decodeUnknownSync(MarketplaceOperation.Info)(
          yield* request(`${root}/operations/${installed.id}/cancel`, "POST"),
        ),
      ).toEqual(installed)
      yield* request(`${root}/operations/${MarketplaceOperation.ID.create()}`, "GET", undefined, 400)
      const secondKey = view.listings.find((listing) => listing.item.id === "broken")?.key
      if (!secondKey) throw new Error("Second catalog listing missing")
      const secondPlan = yield* complete((yield* submit("second-plan", { kind: "prepare-install", key: secondKey })).id)
      if (secondPlan.status !== "succeeded" || !secondPlan.result.fingerprint) throw new Error("Second plan missing")
      expect(
        (yield* complete(
          (yield* submit("second-install", {
            kind: "install",
            key: secondKey,
            expected_fingerprint: secondPlan.result.fingerprint,
            accept_untrusted: true,
          })).id,
        )).status,
      ).toBe("succeeded")
      yield* Effect.promise(() =>
        Bun.write(
          catalog,
          JSON.stringify({
            schema: "opencode.marketplace/v1",
            id: "local",
            name: "Local",
            items: [
              {
                id: "commands",
                name: "Commands",
                description: "Local commands",
                kind: "bundle",
                version: "2.0.0",
                install: { commands: { background_command: { template: "Updated" } } },
              },
              {
                id: "broken",
                name: "Broken",
                description: "Unavailable artifact",
                kind: "bundle",
                version: "2.0.0",
                install: { skills: { items: [{ id: "missing", name: "missing", url: "./missing.md" }] } },
              },
            ],
          }),
        ),
      )
      const batch = yield* complete((yield* submit("update", { kind: "update-all", accept_untrusted: true })).id)
      expect(batch.status).toBe("succeeded")
      expect(batch.outcomes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key, status: "succeeded", revision: 4 }),
          expect.objectContaining({
            key: secondKey,
            status: "failed",
            error: expect.objectContaining({ code: "download" }),
          }),
        ]),
      )
      expect(batch.outcomes).toHaveLength(2)
      const updated = Schema.decodeUnknownSync(Marketplace.View)(yield* request(root))
      expect(updated.state.installed?.[key]?.version).toBe("2.0.0")
      expect(updated.state.installed?.[secondKey]?.version).toBe("1.0.0")
      expect(updated.state.installed?.[secondKey]?.plan).toMatchObject({
        commands: { retained_command: { template: "Keep me" } },
      })
      const invalid = yield* complete(
        (yield* submit("invalid-source", { kind: "source-add", url: "../missing.json" })).id,
      )
      expect(invalid.status).toBe("succeeded")
      const failedSource = Schema.decodeUnknownSync(Marketplace.View)(yield* request(`${root}/snapshot`))
      expect(failedSource.state.sources).toHaveLength(2)
      expect(failedSource.source_status?.some((status) => status.status === "failed")).toBe(true)
    }),
  // Boots a real server and Location, then runs seven durable operations and their configuration reloads.
  { timeout: 15_000 },
)

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
      const request = (route: string, method = "GET", payload?: unknown, status = 200) =>
        Effect.promise(async () => {
          const url = new URL(route, server.base)
          url.searchParams.set("location[directory]", project)
          const response = await fetch(url, {
            method,
            headers: { ...server.headers, "content-type": "application/json" },
            body: payload === undefined ? undefined : JSON.stringify(payload),
          })
          const body: unknown = await response.json()
          expect(response.status).toBe(status)
          return body
        })
      const root = "/api/experimental/marketplace"
      yield* request(`${root}/operations`, "GET", undefined, 503)
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
