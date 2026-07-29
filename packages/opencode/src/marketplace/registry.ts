import path from "path"
import { randomUUID } from "crypto"
import { isDeepStrictEqual } from "util"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { ConfigMarketplaceV1 } from "@opencode-ai/core/v1/config/marketplace"
import type { MarketplaceState } from "@opencode-ai/core/marketplace"

const FILE_SCHEMA = "opencode.marketplace.registry/v1" as const

const RegistryFile = Schema.Struct({
  schema: Schema.Literal(FILE_SCHEMA),
  revision: Schema.Number,
  state: ConfigMarketplaceV1.Info,
})

type RegistryFile = Schema.Schema.Type<typeof RegistryFile>

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("MarketplaceRegistryConflictError", {
  expected: Schema.Number,
  actual: Schema.Number,
}) {
  override get message() {
    return `Marketplace registry changed concurrently (expected revision ${this.expected}, actual ${this.actual})`
  }
}

export class CorruptError extends Schema.TaggedErrorClass<CorruptError>()("MarketplaceRegistryCorruptError", {
  file: Schema.String,
  message: Schema.String,
}) {}

export type ReplaceResult = {
  state: MarketplaceState
  changed: boolean
}

export interface Interface {
  readonly read: () => Effect.Effect<MarketplaceState>
  readonly replace: (state: MarketplaceState) => Effect.Effect<ReplaceResult, ConflictError>
  readonly file: () => string
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MarketplaceRegistry") {}

function normalize(state: MarketplaceState) {
  const { revision: _revision, ...value } = state
  return JSON.parse(JSON.stringify(value)) as Omit<MarketplaceState, "revision">
}

function view(file: RegistryFile): MarketplaceState {
  const state = structuredClone(file.state) as MarketplaceState
  return { ...state, revision: file.revision }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service
    const decode = Schema.decodeUnknownSync(RegistryFile)
    const file = () => path.join(Global.Path.data, "marketplace", "registry.json")

    const readUnsafe = Effect.fnUntraced(function* () {
      const target = file()
      const text = yield* fs.readFileStringSafe(target).pipe(Effect.orDie)
      if (!text) return { schema: FILE_SCHEMA, revision: 0, state: {} }
      return yield* Effect.try({
        try: () => decode(JSON.parse(text)),
        catch: (error) =>
          new CorruptError({
            file: target,
            message: error instanceof Error ? error.message : String(error),
          }),
      }).pipe(Effect.orDie)
    })

    const read = Effect.fn("MarketplaceRegistry.read")(function* () {
      return view(yield* readUnsafe())
    })

    const replace = Effect.fn("MarketplaceRegistry.replace")(function* (state: MarketplaceState) {
      const target = file()
      return yield* flock
        .withLock(
          Effect.gen(function* () {
            const current = yield* readUnsafe()
            const desired = normalize(state)
            if (isDeepStrictEqual(current.state, desired)) return { state: view(current), changed: false }

            const expected = state.revision ?? 0
            if (expected !== current.revision) {
              return yield* new ConflictError({ expected, actual: current.revision })
            }

            const next: RegistryFile = {
              schema: FILE_SCHEMA,
              revision: current.revision + 1,
              state: desired,
            }
            const staging = `${target}.tmp-${randomUUID()}`
            yield* fs.writeWithDirs(staging, JSON.stringify(next, null, 2), 0o600).pipe(Effect.orDie)
            yield* fs
              .rename(staging, target)
              .pipe(Effect.orDie, Effect.ensuring(fs.remove(staging, { force: true }).pipe(Effect.ignore)))
            return { state: view(next), changed: true }
          }),
          `marketplace-registry:${target}`,
        )
        .pipe(Effect.orDie)
    })

    return Service.of({ read, replace, file })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [FSUtil.node, EffectFlock.node],
})
