import { isDeepStrictEqual } from "util"
import { Context, Effect, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import type { MarketplaceInstalled, MarketplaceSource, MarketplaceState } from "@opencode-ai/core/marketplace"

const REGISTRY_ID = 1

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("MarketplaceRegistryConflictError", {
  expected: Schema.Number,
  actual: Schema.Number,
}) {
  override get message() {
    return `Marketplace registry changed concurrently (expected revision ${this.expected}, actual ${this.actual})`
  }
}

export type ReplaceResult = {
  state: MarketplaceState
  changed: boolean
}

export interface Interface {
  readonly read: () => Effect.Effect<MarketplaceState>
  readonly replace: (state: MarketplaceState) => Effect.Effect<ReplaceResult, ConflictError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MarketplaceRegistry") {}

type Executor = Pick<Database.Interface["db"], "all" | "run">

function parseJson<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T
  return structuredClone(value) as T
}

function normalize(state: MarketplaceState): Omit<MarketplaceState, "revision"> {
  const value: Omit<MarketplaceState, "revision"> = {}
  if (state.sources !== undefined) value.sources = structuredClone(state.sources)
  if (state.installed !== undefined) value.installed = structuredClone(state.installed)
  return JSON.parse(JSON.stringify(value)) as Omit<MarketplaceState, "revision">
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const readFrom = Effect.fnUntraced(function* (executor: Executor) {
      const now = Date.now()
      yield* executor
        .run(
          sql`INSERT OR IGNORE INTO marketplace_registry (id, revision, time_updated)
              VALUES (${REGISTRY_ID}, 0, ${now})`,
        )
        .pipe(Effect.orDie)

      const meta = (yield* executor
        .all<{ revision: number }>(sql`SELECT revision FROM marketplace_registry WHERE id = ${REGISTRY_ID} LIMIT 1`)
        .pipe(Effect.orDie))[0]

      const sourceRows = yield* executor
        .all<{ data: unknown }>(sql`SELECT data FROM marketplace_source ORDER BY position ASC, id ASC`)
        .pipe(Effect.orDie)
      const installRows = yield* executor
        .all<{
          key: string
          data: unknown
        }>(sql`SELECT key, data FROM marketplace_install ORDER BY position ASC, key ASC`)
        .pipe(Effect.orDie)

      const sources = sourceRows.map((row) => parseJson<MarketplaceSource>(row.data))
      const installed = Object.fromEntries(
        installRows.map((row) => [row.key, parseJson<MarketplaceInstalled>(row.data)] as const),
      )

      return {
        revision: meta?.revision ?? 0,
        ...(sources.length ? { sources } : {}),
        ...(installRows.length ? { installed } : {}),
      } satisfies MarketplaceState
    })

    const read = Effect.fn("MarketplaceRegistry.read")(function* () {
      return yield* readFrom(db)
    })

    const replace = Effect.fn("MarketplaceRegistry.replace")(function* (state: MarketplaceState) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* readFrom(tx as unknown as Executor)
            const desired = normalize(state)
            const existing = normalize(current)
            if (isDeepStrictEqual(existing, desired)) return { state: current, changed: false }

            const expected = state.revision ?? 0
            const actual = current.revision ?? 0
            if (expected !== actual) return yield* new ConflictError({ expected, actual })

            const now = Date.now()
            const revision = actual + 1
            yield* tx
              .run(
                sql`UPDATE marketplace_registry
                  SET revision = ${revision}, time_updated = ${now}
                  WHERE id = ${REGISTRY_ID}`,
              )
              .pipe(Effect.orDie)
            yield* tx.run(sql`DELETE FROM marketplace_source`).pipe(Effect.orDie)
            yield* tx.run(sql`DELETE FROM marketplace_install`).pipe(Effect.orDie)

            for (const [position, source] of (desired.sources ?? []).entries()) {
              yield* tx
                .run(
                  sql`INSERT INTO marketplace_source (id, data, position, time_created, time_updated)
                    VALUES (${source.id}, ${JSON.stringify(source)}, ${position}, ${now}, ${now})`,
                )
                .pipe(Effect.orDie)
            }

            for (const [position, [key, installed]] of Object.entries(desired.installed ?? {}).entries()) {
              yield* tx
                .run(
                  sql`INSERT INTO marketplace_install (key, data, position, time_created, time_updated)
                    VALUES (${key}, ${JSON.stringify(installed)}, ${position}, ${now}, ${now})`,
                )
                .pipe(Effect.orDie)
            }

            return {
              state: {
                ...structuredClone(desired),
                revision,
              },
              changed: true,
            }
          }),
        )
        .pipe(Effect.catch((error) => (error instanceof ConflictError ? Effect.fail(error) : Effect.die(error))))
    })

    return Service.of({ read, replace })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node],
})
