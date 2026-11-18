import fs from "fs/promises"
import os from "os"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { beforeEach, describe, expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { MarketplaceOperationContext } from "../../src/marketplace/operation-context.js"
import { tmpdirScoped } from "../fixture/tmpdir"
import { sql } from "drizzle-orm"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "../../src/database/database.js"
import { testEffect } from "../lib/effect"
import { MarketplaceCache } from "../../src/marketplace/cache.js"

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
  it.live("serves cache-only reads without contacting an uncached or cached remote source", () =>
    Effect.gen(function* () {
      const requests = { count: 0 }
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            fetch() {
              requests.count++
              return new Response("catalog")
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      const cache = yield* MarketplaceCache.Service
      expect((yield* cache.fetchResponse({ url: server.url.href, mode: "cache-only" }).pipe(Effect.result))._tag).toBe(
        "Failure",
      )
      expect(requests.count).toBe(0)
      yield* cache.fetchResponse({ url: server.url.href })
      expect(requests.count).toBe(1)
      expect(
        yield* Effect.promise(() =>
          cache
            .fetcher("cache-only")(server.url)
            .then((response) => response.text()),
        ),
      ).toBe("catalog")
      expect(requests.count).toBe(1)
    }),
  )
  it.live("aborts an in-flight HTTP body when the execution fiber is cancelled", () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>()
      const aborted = Promise.withResolvers<void>()
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            fetch(request) {
              request.signal.addEventListener("abort", () => aborted.resolve(), { once: true })
              return new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode("partial"))
                    started.resolve()
                  },
                  cancel() {
                    aborted.resolve()
                  },
                }),
              )
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      const cache = yield* MarketplaceCache.Service
      const fiber = yield* cache.fetchResponse({ url: server.url.href }).pipe(Effect.forkChild())
      yield* Effect.promise(() => started.promise)
      yield* Fiber.interrupt(fiber)
      yield* Effect.promise(() => aborted.promise).pipe(Effect.timeout("5 seconds"))
      expect((yield* cache.summary()).fetch_entries).toBe(0)
    }),
  )

  it.live("removes staging on cancellation between files without publishing a materialized tree", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const root = pathToFileURL(tmp.path + path.sep).href
      yield* Effect.promise(async () => {
        await Bun.write(path.join(tmp.path, "SKILL.md"), "Skill")
        await Bun.write(path.join(tmp.path, "helper.txt"), "Companion")
      })
      const cache = yield* MarketplaceCache.Service
      const result = yield* cache
        .materializePlan(
          {
            skills: {
              items: [
                {
                  id: "skill",
                  name: "skill",
                  files: { "SKILL.md": new URL("SKILL.md", root).href, "helper.txt": new URL("helper.txt", root).href },
                },
              ],
            },
          },
          { id: "local", name: "Local", url: new URL("marketplace.json", root).href },
        )
        .pipe(
          Effect.provideService(MarketplaceOperationContext.Current, {
            phase: () => Effect.void,
            progress: (progress) => (progress.completed === 1 ? Effect.interrupt : Effect.void),
            commit: () => Effect.void,
            outcome: () => Effect.void,
            warning: () => Effect.void,
          }),
          Effect.exit,
        )
      expect(result._tag).toBe("Failure")
      const summary = yield* cache.summary()
      expect(summary.materializations).toBe(0)
      const staging = yield* Effect.promise(() =>
        Array.fromAsync(new Bun.Glob("**/*.tmp-*").scan({ cwd: summary.root, onlyFiles: false })),
      )
      expect(staging).toEqual([])
    }),
  )

  it.live("materializes a foreign skill with its companion files in an immutable tree", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch(request) {
            const file = new URL(request.url).pathname
            if (file === "/SKILL.md")
              return new Response("---\nname: review\ndescription: Review\n---\nUse scripts/check.py")
            if (file === "/scripts/check.py") return new Response("print('check')")
            return new Response("not found", { status: 404 })
          },
        }),
      ),
      (server) =>
        Effect.gen(function* () {
          const cache = yield* MarketplaceCache.Service
          const source = { id: "foreign", name: "Foreign", url: new URL("marketplace.json", server.url).href }
          const materialized = yield* cache.materializePlan(
            {
              skills: {
                items: [
                  {
                    id: "review",
                    name: "review",
                    url: new URL("SKILL.md", server.url).href,
                    files: {
                      "SKILL.md": new URL("SKILL.md", server.url).href,
                      "scripts/check.py": new URL("scripts/check.py", server.url).href,
                    },
                  },
                ],
              },
            },
            source,
          )
          const skill = materialized.plan.skills?.items?.[0]
          if (!skill?.path) throw new Error("Expected a materialized skill path")
          const root = skill.path
          expect(skill.url).toBeUndefined()
          expect(yield* Effect.promise(() => Bun.file(path.join(root, "SKILL.md")).text())).toContain(
            "Use scripts/check.py",
          )
          expect(yield* Effect.promise(() => Bun.file(path.join(root, "scripts/check.py")).text())).toBe(
            "print('check')",
          )
          expect(materialized.artifactDigests).toHaveLength(2)
          expect(materialized.treeDigest).toMatch(/^sha256:/)
        }),
      (server) => Effect.sync(() => server.stop(true)),
    ),
  )

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
          if (typeof pluginSpec !== "string") throw new Error("Expected a materialized plugin directory")
          expect(
            yield* Effect.promise(() => fs.readFile(path.join(fileURLToPath(pluginSpec), "index.ts"), "utf8")),
          ).toContain("MarketplacePlugin")
          const skillItem = materialized.plan.skills?.items?.[0]
          expect(skillItem?.url).toBeUndefined()
          expect(yield* Effect.promise(() => fs.readFile(path.join(skillItem!.path!, "SKILL.md"), "utf8"))).toContain(
            "Review the current diff",
          )
          const mcpCommand = materialized.plan.mcp?.review_tools?.command
          if (!Array.isArray(mcpCommand)) throw new Error("Expected a materialized MCP command")
          expect(mcpCommand?.[1]?.startsWith(root)).toBe(false)
          expect(yield* Effect.promise(() => fs.readFile(String(mcpCommand?.[1]), "utf8"))).toContain(
            "MarketplacePlugin",
          )
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
