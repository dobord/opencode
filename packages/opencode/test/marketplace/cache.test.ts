import fs from "fs/promises"
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
