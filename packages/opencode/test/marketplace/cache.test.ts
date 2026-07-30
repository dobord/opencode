import fs from "fs/promises"
import os from "os"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { beforeEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { testEffect } from "../lib/effect"
import * as MarketplaceCache from "@/marketplace/cache"

const layer = LayerNode.compile(LayerNode.group([Database.node, MarketplaceCache.node]))
const it = testEffect(layer)

beforeEach(async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(sql`DELETE FROM marketplace_fetch`).pipe(Effect.orDie)
      yield* db.run(sql`DELETE FROM marketplace_materialization`).pipe(Effect.orDie)
      yield* db.run(sql`DELETE FROM marketplace_artifact`).pipe(Effect.orDie)
    }).pipe(Effect.provide(layer)),
  )
})

describe("marketplace content-addressed cache", () => {
  it.effect("deduplicates identical bytes by sha256 digest", () =>
    Effect.gen(function* () {
      const cache = yield* MarketplaceCache.Service
      const bytes = new TextEncoder().encode("same artifact")
      const first = yield* cache.put(bytes, { kind: "test" })
      const second = yield* cache.put(bytes, { kind: "test" })
      expect(first.digest).toBe(second.digest)
      expect(first.path).toBe(second.path)
      expect((yield* cache.summary()).objects).toBe(1)
    }),
  )

  it.effect("reads local sources and materializes local plugins, skills, and instructions", () =>
    Effect.acquireUseRelease(
      Effect.tryPromise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-marketplace-cache-"))),
      (root) =>
        Effect.gen(function* () {
          const catalog = path.join(root, "marketplace.json")
          const plugin = path.join(root, "plugin.ts")
          const skill = path.join(root, "skills", "review", "SKILL.md")
          const instruction = path.join(root, "review.md")
          yield* Effect.tryPromise(async () => {
            await fs.mkdir(path.dirname(skill), { recursive: true })
            await fs.writeFile(catalog, '{"version":1}')
            await fs.writeFile(plugin, "export const MarketplacePlugin = async () => ({})")
            await fs.writeFile(skill, "---\nname: review\ndescription: Review changes\n---\nReview the current diff.")
            await fs.writeFile(instruction, "Always review the current diff.")
          })

          const cache = yield* MarketplaceCache.Service
          const first = yield* cache.fetchResponse({
            url: pathToFileURL(catalog).href,
            mode: "refresh",
            kind: "catalog",
          })
          expect(yield* Effect.promise(() => first.text())).toBe('{"version":1}')
          yield* Effect.tryPromise(() => fs.writeFile(catalog, '{"version":2}'))
          const cached = yield* cache.fetchResponse({ url: pathToFileURL(catalog).href, kind: "catalog" })
          expect(yield* Effect.promise(() => cached.text())).toBe('{"version":1}')
          const refreshed = yield* cache.fetchResponse({
            url: pathToFileURL(catalog).href,
            mode: "refresh",
            kind: "catalog",
          })
          expect(yield* Effect.promise(() => refreshed.text())).toBe('{"version":2}')

          const materialized = yield* cache.materializePlan(
            {
              plugins: [pathToFileURL(plugin).href],
              skills: {
                items: [{ id: "review", name: "review", url: pathToFileURL(path.dirname(skill)).href + "/" }],
              },
              mcp: { review_tools: { type: "local", command: [process.execPath, pathToFileURL(plugin).href] } },
              instructions: [pathToFileURL(instruction).href],
            },
            {
              id: "local",
              name: "Local",
              url: pathToFileURL(catalog).href,
              trust: "private",
            },
          )

          const pluginSpec = materialized.plan.plugins?.[0]
          expect(typeof pluginSpec).toBe("string")
          expect(yield* Effect.promise(() => fs.readFile(fileURLToPath(pluginSpec as string), "utf8"))).toContain(
            "MarketplacePlugin",
          )
          const skillItem = materialized.plan.skills?.items?.[0]
          expect(skillItem?.url).toBeUndefined()
          expect(yield* Effect.promise(() => fs.readFile(path.join(skillItem!.path!, "SKILL.md"), "utf8"))).toContain(
            "Review the current diff",
          )
          const mcpCommand = materialized.plan.mcp?.review_tools?.command
          if (!Array.isArray(mcpCommand)) throw new Error("Expected a materialized MCP command")
          expect(mcpCommand?.[1]?.startsWith(root)).toBe(false)
          expect(yield* Effect.promise(() => fs.readFile(String(mcpCommand?.[1]), "utf8"))).toContain("MarketplacePlugin")
          const materializedInstruction = materialized.plan.instructions?.[0]
          expect(materializedInstruction?.startsWith("file:")).toBe(false)
          expect(yield* Effect.promise(() => fs.readFile(materializedInstruction!, "utf8"))).toContain("Always review")
          expect(materialized.artifactDigests.length).toBeGreaterThanOrEqual(3)
        }),
      (root) => Effect.tryPromise(() => fs.rm(root, { recursive: true, force: true })),
    ),
  )

  it.effect("prevents network catalogs and local path escapes from reading file artifacts", () =>
    Effect.acquireUseRelease(
      Effect.tryPromise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-marketplace-boundary-"))),
      (root) =>
        Effect.gen(function* () {
          const sourceRoot = path.join(root, "source")
          const catalog = path.join(sourceRoot, "marketplace.json")
          const outside = path.join(root, "outside.md")
          yield* Effect.tryPromise(async () => {
            await fs.mkdir(sourceRoot, { recursive: true })
            await fs.writeFile(catalog, "{}")
            await fs.writeFile(outside, "must not be loaded")
          })

          const cache = yield* MarketplaceCache.Service
          const fileURL = pathToFileURL(outside).href
          const escaped = yield* cache
            .materializePlan(
              { instructions: [fileURL] },
              { id: "local", name: "Local", url: pathToFileURL(catalog).href, trust: "private" },
            )
            .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }))
          expect(escaped?.message).toContain("escapes its source directory")

          const remote = yield* cache
            .materializePlan(
              { instructions: [fileURL] },
              { id: "remote", name: "Remote", url: "https://example.test/marketplace.json", trust: "community" },
            )
            .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }))
          expect(remote?.message).toContain("cannot reference local file")
        }),
      (root) => Effect.tryPromise(() => fs.rm(root, { recursive: true, force: true })),
    ),
  )

  it.effect("materializes a remote skill into an immutable local tree", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch(request) {
            const url = new URL(request.url)
            if (url.pathname.endsWith("/index.json")) return new Response("not found", { status: 404 })
            if (url.pathname.endsWith("/skill.md")) {
              return new Response("---\nname: review\ndescription: Review changes\n---\nReview the current diff.", {
                headers: { "content-type": "text/markdown" },
              })
            }
            return new Response("not found", { status: 404 })
          },
        }),
      ),
      (server) =>
        Effect.gen(function* () {
          const cache = yield* MarketplaceCache.Service
          const url = new URL("skill.md", server.url).href
          const materialized = yield* cache.materializePlan(
            {
              skills: {
                items: [{ id: "review", name: "review", url }],
              },
            },
            {
              id: "local",
              name: "Local",
              url: new URL("catalog.json", server.url).href,
              trust: "private",
            },
          )
          const item = materialized.plan.skills?.items?.[0]
          expect(item?.url).toBeUndefined()
          expect(item?.path).toBeDefined()
          expect(yield* Effect.promise(() => fs.readFile(`${item!.path}/SKILL.md`, "utf8"))).toContain(
            "Review the current diff",
          )
          expect(materialized.treeDigest).toMatch(/^sha256:/)
          expect(materialized.artifactDigests.length).toBeGreaterThan(0)
        }),
      (server) => Effect.promise(async () => void (await server.stop(true))),
    ),
  )
})
