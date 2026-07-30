import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import {
  createMarketplaceSource,
  loadMarketplace,
  marketplaceActivePlan,
  marketplaceConflicts,
  marketplaceEnabledMcpNames,
  marketplaceFingerprint,
  marketplaceInitialDisabledMcp,
  marketplacePermissions,
  marketplacePlanSummary,
  marketplaceSkillComponents,
  marketplaceSnapshot,
  marketplaceStatus,
  removeMarketplaceSource,
  toggleMarketplaceSource,
  upsertMarketplaceSource,
  type MarketplaceConfiguredTrust,
  type MarketplaceHostConfig,
  type MarketplaceInstalled,
  type MarketplaceListing,
  type MarketplaceMutationResult,
  type MarketplacePlanResult,
  type MarketplaceSource,
  type MarketplaceState,
  type MarketplaceView,
} from "@opencode-ai/core/marketplace"
import { exportMarketplaceProfile, type MarketplaceProfile } from "@opencode-ai/core/marketplace-profile"
import { Config } from "@/config/config"
import { composeMarketplaceConfig } from "./overlay"
import * as MarketplaceRegistry from "./registry"
import * as MarketplaceCache from "./cache"
import { resolveMarketplaceSourceReference } from "./source"

export type InstallInput = {
  key: string
  expectedRevision: number
  force?: boolean
  acceptUntrusted?: boolean
}

export type UpdateAllInput = {
  expectedRevision: number
  force?: boolean
  acceptUntrusted?: boolean
}

export type ToggleInput = {
  key: string
  expectedRevision: number
  component: "package" | "skill" | "mcp"
  id?: string
  enabled: boolean
}

export type SourceAddInput = {
  expectedRevision: number
  url: string
  name?: string
  trust?: MarketplaceConfiguredTrust
  headers?: Record<string, string>
}

export interface Interface {
  readonly get: (options?: { refresh?: boolean }) => Effect.Effect<MarketplaceView>
  readonly plan: (key: string) => Effect.Effect<MarketplacePlanResult>
  readonly install: (input: InstallInput) => Effect.Effect<MarketplaceMutationResult>
  readonly updateAll: (input: UpdateAllInput) => Effect.Effect<MarketplaceMutationResult>
  readonly uninstall: (input: { key: string; expectedRevision: number }) => Effect.Effect<MarketplaceMutationResult>
  readonly toggle: (input: ToggleInput) => Effect.Effect<MarketplaceMutationResult>
  readonly sourceAdd: (input: SourceAddInput) => Effect.Effect<MarketplaceMutationResult>
  readonly sourceToggle: (input: {
    id: string
    expectedRevision: number
    enabled: boolean
  }) => Effect.Effect<MarketplaceMutationResult>
  readonly sourceRemove: (input: { id: string; expectedRevision: number }) => Effect.Effect<MarketplaceMutationResult>
  readonly profileExport: (input?: { name?: string; description?: string }) => Effect.Effect<MarketplaceProfile>
  readonly cachePrune: (input?: { maxAgeDays?: number }) => Effect.Effect<MarketplaceView["cache"]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MarketplaceService") {}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function publicSource(source: MarketplaceSource): MarketplaceSource {
  const { headers: _headers, ...value } = source
  return value
}

function publicState(state: MarketplaceState): MarketplaceState {
  return {
    revision: state.revision ?? 0,
    ...(state.sources ? { sources: state.sources.map(publicSource) } : {}),
    ...(state.installed
      ? {
          installed: Object.fromEntries(
            Object.entries(state.installed).map(([key, installed]) => {
              const {
                materialized_plan: _materializedPlan,
                active_plan: _activePlan,
                artifact_digests: _artifactDigests,
                catalog_digest: _catalogDigest,
                manifest_digest: _manifestDigest,
                materialized_digest: _materializedDigest,
                ...value
              } = installed
              return [key, { ...value, receipt: {} }]
            }),
          ),
        }
      : {}),
  }
}

function publicListing(listing: MarketplaceListing): MarketplaceListing {
  return {
    ...listing,
    source: publicSource(listing.source),
  }
}

function revisionFailure(expected: number, actual: number): MarketplaceMutationResult {
  return {
    ok: false,
    reason: "revision",
    message: `Marketplace state changed concurrently (expected revision ${expected}, actual ${actual})`,
    revision: actual,
  }
}

function notFound(message: string): MarketplaceMutationResult {
  return { ok: false, reason: "not_found", message }
}

function stateWithout(state: MarketplaceState, key: string): MarketplaceState {
  const installed = { ...(state.installed ?? {}) }
  delete installed[key]
  return {
    ...clone(state),
    installed,
  }
}

function trusted(source: MarketplaceSource) {
  return source.trust === "official" || source.trust === "verified"
}

function sourceHeaders(source: MarketplaceSource, target: string) {
  if (!source.headers) return undefined
  try {
    const left = new URL(source.url)
    const right = new URL(target)
    if (!["http:", "https:"].includes(left.protocol) || !["http:", "https:"].includes(right.protocol)) {
      return undefined
    }
    return left.origin === right.origin ? source.headers : undefined
  } catch {
    return undefined
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = yield* MarketplaceRegistry.Service
    const cache = yield* MarketplaceCache.Service
    const config = yield* Config.Service

    const loadView = Effect.fnUntraced(function* (state: MarketplaceState, refresh: boolean) {
      const loaded = yield* Effect.tryPromise({
        try: () =>
          loadMarketplace({
            config: { marketplace: state },
            fetch: cache.fetcher(refresh ? "refresh" : "cache-first"),
          }),
        catch: (error) => error,
      }).pipe(Effect.orDie)
      return {
        state: publicState(state),
        listings: loaded.listings.map(publicListing),
        errors: loaded.errors.map((error) => ({ ...error, source: publicSource(error.source) })),
        cache: yield* cache.summary(),
      } satisfies MarketplaceView
    })

    const get = Effect.fn("MarketplaceService.get")(function* (options?: { refresh?: boolean }) {
      return yield* loadView(yield* registry.read(), options?.refresh === true)
    })

    const rawBase = Effect.fnUntraced(function* () {
      return (yield* config.getGlobalBase()) as MarketplaceHostConfig
    })

    const conflictList = Effect.fnUntraced(function* (state: MarketplaceState, listing: MarketplaceListing) {
      const base = yield* rawBase()
      const effective = composeMarketplaceConfig(base, stateWithout(state, listing.key))
      return marketplaceConflicts(effective, listing.item.install)
    })

    const plan = Effect.fn("MarketplaceService.plan")(function* (key: string) {
      const state = yield* registry.read()
      const view = yield* loadView(state, false)
      const listing = view.listings.find((candidate) => candidate.key === key)
      if (!listing) {
        return {
          ok: false,
          reason: "not_found",
          message: `Marketplace item not found: ${key}`,
        } satisfies MarketplacePlanResult
      }
      const status = marketplaceStatus({ marketplace: state }, listing)
      return {
        ok: true,
        key,
        action: status === "update" ? "update" : "install",
        trust_warning: !trusted(listing.source),
        conflicts: yield* conflictList(state, listing),
        permissions: marketplacePermissions(listing.item),
        summary: marketplacePlanSummary(listing.item.install),
      } satisfies MarketplacePlanResult
    })

    const findListing = Effect.fnUntraced(function* (state: MarketplaceState, key: string, refresh: boolean) {
      const loaded = yield* Effect.tryPromise({
        try: () =>
          loadMarketplace({
            config: { marketplace: state },
            fetch: cache.fetcher(refresh ? "refresh" : "cache-first"),
          }),
        catch: (error) => error,
      }).pipe(Effect.orDie)
      return loaded.listings.find((listing) => listing.key === key)
    })

    const prepare = Effect.fnUntraced(function* (input: {
      state: MarketplaceState
      listing: MarketplaceListing
      force?: boolean
      acceptUntrusted?: boolean
    }) {
      const conflicts = yield* conflictList(input.state, input.listing)
      if (conflicts.length && !input.force) {
        return {
          ok: false as const,
          failure: {
            ok: false,
            reason: "conflict",
            message: `Marketplace item conflicts with ${conflicts.map((item) => item.path).join(", ")}`,
            revision: input.state.revision ?? 0,
            conflicts,
          } satisfies MarketplaceMutationResult,
        }
      }

      if (!trusted(input.listing.source) && !input.acceptUntrusted) {
        return {
          ok: false as const,
          failure: {
            ok: false,
            reason: "trust",
            message: `Catalog ${input.listing.source.name} is marked ${input.listing.source.trust ?? "community"}`,
            revision: input.state.revision ?? 0,
          } satisfies MarketplaceMutationResult,
        }
      }

      const materialized = yield* cache.materializePlan(input.listing.item.install, input.listing.source).pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error) =>
          Effect.succeed({
            ok: false as const,
            failure: {
              ok: false,
              reason: "materialization",
              message: error.message,
              revision: input.state.revision ?? 0,
            } satisfies MarketplaceMutationResult,
          }),
        ),
      )
      if (!materialized.ok) return materialized

      const manifest = yield* cache
        .putJson(
          {
            schema: "opencode.marketplace.manifest/v1",
            source: {
              id: input.listing.source.id,
              name: input.listing.source.name,
              url: input.listing.source.url,
              trust: input.listing.source.trust,
            },
            catalog: {
              id: input.listing.catalog.id,
              name: input.listing.catalog.name,
            },
            item: input.listing.item,
          },
          { kind: "item-manifest", sourceUrl: input.listing.catalog_url ?? input.listing.source.url },
        )
        .pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catch((error) =>
            Effect.succeed({
              ok: false as const,
              failure: {
                ok: false,
                reason: "materialization",
                message: error.message,
                revision: input.state.revision ?? 0,
              } satisfies MarketplaceMutationResult,
            }),
          ),
        )
      if (!manifest.ok) return manifest

      const artifactDigests = new Set(materialized.value.artifactDigests)
      artifactDigests.add(manifest.value.digest)
      if (input.listing.catalog_digest) artifactDigests.add(input.listing.catalog_digest)

      for (const icon of Object.values(input.listing.item.icon ?? {})) {
        if (!/^(?:https?|file):/i.test(icon)) continue
        yield* cache
          .fetchResponse({
            url: icon,
            headers: sourceHeaders(input.listing.source, icon),
            kind: "icon",
            mode: "refresh",
            source: input.listing.source,
          })
          .pipe(
            Effect.tap((response) =>
              Effect.sync(() => {
                const digest = response.headers.get("x-opencode-artifact-digest")
                if (digest) artifactDigests.add(digest)
              }),
            ),
            Effect.catch(() => Effect.void),
          )
      }

      const current = input.state.installed?.[input.listing.key]
      const components = marketplaceSkillComponents(input.listing.item.install)
      const disabledSkills =
        current?.disabled_skills?.filter((id) => components.some((component) => component.id === id)) ??
        components.filter((component) => component.enabled === false).map((component) => component.id)
      const disabledMcp =
        current?.disabled_mcp?.filter((id) => id in (input.listing.item.install.mcp ?? {})) ??
        marketplaceInitialDisabledMcp(input.listing.item.install)
      const enabled = current?.enabled !== false
      const activePlan = marketplaceActivePlan(materialized.value.plan, {
        enabled,
        disabled_skills: disabledSkills,
        disabled_mcp: disabledMcp,
      })
      const now = new Date().toISOString()

      const installed: MarketplaceInstalled = {
        source: input.listing.source.id,
        source_url: input.listing.source.reference ?? input.listing.source.url,
        source_trust: input.listing.source.trust,
        catalog: input.listing.catalog.id,
        catalog_name: input.listing.catalog.name,
        item: input.listing.item.id,
        name: input.listing.item.name,
        kind: input.listing.item.kind,
        version: input.listing.item.version,
        publisher: input.listing.item.publisher?.name ?? input.listing.catalog.publisher?.name,
        fingerprint: marketplaceFingerprint(input.listing.item),
        installed_at: current?.installed_at ?? now,
        updated_at: now,
        snapshot: marketplaceSnapshot(input.listing.item),
        plan: clone(input.listing.item.install),
        materialized_plan: materialized.value.plan,
        active_plan: activePlan,
        receipt: {},
        enabled,
        ...(disabledSkills.length ? { disabled_skills: disabledSkills } : {}),
        ...(disabledMcp.length ? { disabled_mcp: disabledMcp } : {}),
        ...(input.listing.catalog_digest ? { catalog_digest: input.listing.catalog_digest } : {}),
        manifest_digest: manifest.value.digest,
        ...(materialized.value.treeDigest ? { materialized_digest: materialized.value.treeDigest } : {}),
        artifact_digests: Array.from(artifactDigests).toSorted(),
      }

      return { ok: true as const, installed }
    })

    const persist = Effect.fnUntraced(function* (input: {
      state: MarketplaceState
      connectMcp?: string[]
      preserved?: string[]
    }) {
      const stored = yield* registry.replace(input.state).pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      )
      if (!stored.ok) {
        const error = stored.error
        if (error instanceof MarketplaceRegistry.ConflictError) return revisionFailure(error.expected, error.actual)
        return revisionFailure(input.state.revision ?? 0, (yield* registry.read()).revision ?? 0)
      }
      if (stored.value.changed) yield* config.invalidate()
      return {
        ok: true,
        changed: stored.value.changed,
        view: yield* loadView(stored.value.state, false),
        connect_mcp: Array.from(new Set(input.connectMcp ?? [])).toSorted(),
        preserved: input.preserved ?? [],
      } satisfies MarketplaceMutationResult
    })

    const install = Effect.fn("MarketplaceService.install")(function* (input: InstallInput) {
      const state = yield* registry.read()
      if ((state.revision ?? 0) !== input.expectedRevision) {
        return revisionFailure(input.expectedRevision, state.revision ?? 0)
      }
      const listing = yield* findListing(state, input.key, true)
      if (!listing) return notFound(`Marketplace item not found: ${input.key}`)
      const prepared = yield* prepare({
        state,
        listing,
        force: input.force,
        acceptUntrusted: input.acceptUntrusted,
      })
      if (!prepared.ok) return prepared.failure
      const next: MarketplaceState = {
        ...clone(state),
        installed: {
          ...(state.installed ?? {}),
          [listing.key]: prepared.installed,
        },
      }
      return yield* persist({
        state: next,
        connectMcp: marketplaceEnabledMcpNames(
          { marketplace: { installed: { [listing.key]: prepared.installed } } },
          listing.key,
        ),
      })
    })

    const updateAll = Effect.fn("MarketplaceService.updateAll")(function* (input: UpdateAllInput) {
      const state = yield* registry.read()
      if ((state.revision ?? 0) !== input.expectedRevision) {
        return revisionFailure(input.expectedRevision, state.revision ?? 0)
      }
      const loaded = yield* Effect.tryPromise({
        try: () => loadMarketplace({ config: { marketplace: state }, fetch: cache.fetcher("refresh") }),
        catch: (error) => error,
      }).pipe(Effect.orDie)
      const candidates = loaded.listings.filter(
        (listing) => marketplaceStatus({ marketplace: state }, listing) === "update",
      )
      if (candidates.length === 0) {
        return {
          ok: true,
          changed: false,
          view: yield* loadView(state, false),
          connect_mcp: [],
          preserved: [],
        } satisfies MarketplaceMutationResult
      }

      let working = clone(state)
      const connect: string[] = []
      for (const listing of candidates) {
        const prepared = yield* prepare({
          state: working,
          listing,
          force: input.force,
          acceptUntrusted: input.acceptUntrusted,
        })
        if (!prepared.ok) return prepared.failure
        working.installed = {
          ...(working.installed ?? {}),
          [listing.key]: prepared.installed,
        }
        connect.push(
          ...marketplaceEnabledMcpNames(
            { marketplace: { installed: { [listing.key]: prepared.installed } } },
            listing.key,
          ),
        )
      }
      return yield* persist({ state: working, connectMcp: connect })
    })

    const uninstall = Effect.fn("MarketplaceService.uninstall")(function* (input: {
      key: string
      expectedRevision: number
    }) {
      const state = yield* registry.read()
      if ((state.revision ?? 0) !== input.expectedRevision) {
        return revisionFailure(input.expectedRevision, state.revision ?? 0)
      }
      if (!state.installed?.[input.key]) return notFound(`Marketplace install not found: ${input.key}`)
      const installed = { ...state.installed }
      delete installed[input.key]
      return yield* persist({
        state: {
          ...clone(state),
          installed,
        },
      })
    })

    const toggle = Effect.fn("MarketplaceService.toggle")(function* (input: ToggleInput) {
      const state = yield* registry.read()
      if ((state.revision ?? 0) !== input.expectedRevision) {
        return revisionFailure(input.expectedRevision, state.revision ?? 0)
      }
      const current = state.installed?.[input.key]
      if (!current) return notFound(`Marketplace install not found: ${input.key}`)

      const next = clone(current)
      if (input.component === "package") {
        next.enabled = input.enabled
      } else if (input.component === "skill") {
        if (!input.id || !marketplaceSkillComponents(next.plan).some((component) => component.id === input.id)) {
          return notFound(`Marketplace skill not found: ${input.id ?? ""}`)
        }
        next.disabled_skills = input.enabled
          ? (next.disabled_skills ?? []).filter((id) => id !== input.id)
          : Array.from(new Set([...(next.disabled_skills ?? []), input.id]))
      } else {
        if (!input.id || !(input.id in (next.plan.mcp ?? {}))) {
          return notFound(`Marketplace MCP server not found: ${input.id ?? ""}`)
        }
        next.disabled_mcp = input.enabled
          ? (next.disabled_mcp ?? []).filter((id) => id !== input.id)
          : Array.from(new Set([...(next.disabled_mcp ?? []), input.id]))
      }

      if (!next.disabled_skills?.length) delete next.disabled_skills
      if (!next.disabled_mcp?.length) delete next.disabled_mcp
      next.active_plan = marketplaceActivePlan(next.materialized_plan ?? next.plan, next)
      next.updated_at = new Date().toISOString()

      const nextState: MarketplaceState = {
        ...clone(state),
        installed: {
          ...state.installed,
          [input.key]: next,
        },
      }
      return yield* persist({
        state: nextState,
        connectMcp: marketplaceEnabledMcpNames({ marketplace: { installed: { [input.key]: next } } }, input.key),
      })
    })

    const sourceAdd = Effect.fn("MarketplaceService.sourceAdd")(function* (input: SourceAddInput) {
      const state = yield* registry.read()
      if ((state.revision ?? 0) !== input.expectedRevision) {
        return revisionFailure(input.expectedRevision, state.revision ?? 0)
      }
      const resolved = yield* Effect.promise(() => resolveMarketplaceSourceReference(input.url))
      const source = {
        ...createMarketplaceSource({
          url: resolved.url,
          name: input.name ?? resolved.name,
          trust: input.trust,
          headers: resolved.local ? undefined : input.headers,
        }),
        reference: resolved.reference,
      }
      const next = upsertMarketplaceSource({ marketplace: state }, source).marketplace ?? state
      return yield* persist({ state: next })
    })

    const sourceToggle = Effect.fn("MarketplaceService.sourceToggle")(function* (input: {
      id: string
      expectedRevision: number
      enabled: boolean
    }) {
      const state = yield* registry.read()
      if ((state.revision ?? 0) !== input.expectedRevision) {
        return revisionFailure(input.expectedRevision, state.revision ?? 0)
      }
      const next = toggleMarketplaceSource({ marketplace: state }, input.id, input.enabled).marketplace ?? state
      return yield* persist({ state: next })
    })

    const sourceRemove = Effect.fn("MarketplaceService.sourceRemove")(function* (input: {
      id: string
      expectedRevision: number
    }) {
      const state = yield* registry.read()
      if ((state.revision ?? 0) !== input.expectedRevision) {
        return revisionFailure(input.expectedRevision, state.revision ?? 0)
      }
      const next = removeMarketplaceSource({ marketplace: state }, input.id).marketplace ?? state
      return yield* persist({ state: next })
    })

    const profileExport = Effect.fn("MarketplaceService.profileExport")(function* (input?: {
      name?: string
      description?: string
    }) {
      return exportMarketplaceProfile(yield* registry.read(), input)
    })

    const cachePrune = Effect.fn("MarketplaceService.cachePrune")(function* (input?: { maxAgeDays?: number }) {
      const state = yield* registry.read()
      const keep = new Set<string>()
      for (const installed of Object.values(state.installed ?? {})) {
        for (const digest of installed.artifact_digests ?? []) keep.add(digest)
        if (installed.catalog_digest) keep.add(installed.catalog_digest)
        if (installed.manifest_digest) keep.add(installed.manifest_digest)
        if (installed.materialized_digest) keep.add(installed.materialized_digest)
      }
      return (yield* cache.prune({ keep, maxAgeDays: input?.maxAgeDays }).pipe(Effect.orDie)).summary
    })

    return Service.of({
      get,
      plan,
      install,
      updateAll,
      uninstall,
      toggle,
      sourceAdd,
      sourceToggle,
      sourceRemove,
      profileExport,
      cachePrune,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Config.node, MarketplaceCache.node, MarketplaceRegistry.node],
})
