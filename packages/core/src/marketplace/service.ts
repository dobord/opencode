export * as MarketplaceService from "./service.js"

import { Context, Effect, Layer } from "effect"
import { createHash } from "node:crypto"
import { MarketplaceOperation } from "@opencode/schema/marketplace-operation"
import { MarketplaceOperationContext } from "./operation-context.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
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
  marketplaceSources,
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
  type MarketplacePluginSpec,
  type MarketplaceSource,
  type MarketplaceState,
  type MarketplaceView,
} from "../marketplace.js"
import { exportMarketplaceProfile, type MarketplaceProfile } from "../marketplace-profile.js"
import { Config } from "../config.js"
import { Location } from "../location.js"
import { Document } from "@opencode/schema/config"
import { composeMarketplaceConfig } from "./overlay"
import { MarketplaceRegistry } from "./registry.js"
import { MarketplaceCache } from "./cache.js"
import { resolveMarketplaceSourceReference } from "./source"
import { resolveForeignMarketplacePlan } from "./foreign.js"

export type InstallInput = {
  key: string
  expectedRevision: number
  force?: boolean
  acceptUntrusted?: boolean
  expectedFingerprint?: string
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
  readonly execute: (
    command: MarketplaceOperation.Command,
  ) => Effect.Effect<MarketplaceOperation.Result, MarketplaceOperation.Failure>
  readonly get: (options?: { refresh?: boolean; cached?: boolean }) => Effect.Effect<MarketplaceView>
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
    sources: marketplaceSources({ marketplace: state }).map(publicSource),
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
    // Listings already contain their item. Repeating a multi-thousand-item
    // catalog in every row makes the response quadratic in catalog size.
    catalog: { ...listing.catalog, items: [] },
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

const cachedIcon = Effect.fnUntraced(function* (
  cache: MarketplaceCache.Interface,
  source: MarketplaceSource,
  url: string,
  mode: MarketplaceCache.CacheMode,
) {
  if (!/^(?:https?|file):/i.test(url)) return url
  return yield* cache.fetchResponse({ url, headers: sourceHeaders(source, url), source, kind: "icon", mode }).pipe(
    Effect.timeout("10 seconds"),
    Effect.flatMap((response) =>
      Effect.tryPromise(async () => {
        const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
        if (!type || !/^image\/(?:png|jpeg|webp|gif|svg\+xml|x-icon)$/.test(type)) return url
        const bytes = await response.arrayBuffer()
        if (bytes.byteLength > 256 * 1024) return url
        return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`
      }),
    ),
    Effect.orElseSucceed(() => url),
  )
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = yield* MarketplaceRegistry.Service
    const cache = yield* MarketplaceCache.Service
    const config = yield* Config.Service
    const location = yield* Location.Service

    const loadView = Effect.fnUntraced(function* (state: MarketplaceState, refresh: boolean, cached = false) {
      const loaded = yield* Effect.tryPromise({
        try: (signal) =>
          loadMarketplace({
            config: { marketplace: state },
            fetch: cache.fetcher(refresh ? "refresh" : cached ? "cache-only" : "cache-first", signal),
          }),
        catch: (error) => error,
      }).pipe(Effect.orDie)
      if (refresh)
        yield* Effect.forEach(
          marketplaceSources({ marketplace: state }),
          (source) => {
            const error = loaded.errors.find((error) => error.source.id === source.id)
            return registry.recordStatus({
              id: source.id,
              status: source.enabled === false ? "disabled" : error ? "failed" : "ready",
              ...(error ? { message: error.message } : {}),
            })
          },
          { discard: true },
        )
      const statuses = yield* registry.statuses()
      const listings = yield* Effect.forEach(
        loaded.listings,
        (listing) =>
          Effect.gen(function* () {
            const installed = state.installed?.[listing.key]
            const item =
              listing.item.install.foreign && installed
                ? { ...listing.item, install: { ...clone(installed.plan), foreign: listing.item.install.foreign } }
                : listing.item
            const icons = yield* Effect.forEach(Object.entries(item.icon ?? {}), ([variant, url]) =>
              Effect.gen(function* () {
                const result = yield* cachedIcon(
                  cache,
                  listing.source,
                  url,
                  refresh ? "refresh" : cached ? "cache-only" : "cache-first",
                )
                return [variant, result] as const
              }),
            )
            return {
              ...publicListing(listing),
              item: { ...item, ...(item.icon ? { icon: { ...item.icon, ...Object.fromEntries(icons) } } : {}) },
              status: marketplaceStatus({ marketplace: state }, listing),
            }
          }),
        { concurrency: 4 },
      )
      return {
        source_status: marketplaceSources({ marketplace: state }).map((source) =>
          source.enabled === false
            ? { id: source.id, status: "disabled" as const }
            : (statuses.find((status) => status.id === source.id) ?? { id: source.id, status: "checking" as const }),
        ),
        state: publicState(state),
        listings,
        errors: loaded.errors.map((error) => ({ ...error, source: publicSource(error.source) })),
        cache: yield* cache.summary(),
      } satisfies MarketplaceView
    })

    const get = Effect.fn("MarketplaceService.get")(function* (options?: { refresh?: boolean; cached?: boolean }) {
      return yield* loadView(yield* registry.read(), options?.refresh === true, options?.cached === true)
    })

    const rawBase = Effect.fnUntraced(function* () {
      const entries = yield* config.entries()
      return entries
        .filter(
          (entry): entry is Document => entry.type === "document" && !(entry instanceof Config.MarketplaceDocument),
        )
        .reduce(
          (base: MarketplaceHostConfig, entry): MarketplaceHostConfig => ({
            ...base,
            plugin: [
              ...(base.plugin ?? []),
              ...(entry.info.plugins ?? []).map(
                (plugin): MarketplacePluginSpec =>
                  typeof plugin === "string" ? plugin : [plugin.package, { ...plugin.options }],
              ),
            ],
            agent: { ...base.agent, ...entry.info.agents },
            command: { ...base.command, ...entry.info.commands },
            mcp: { ...base.mcp, ...entry.info.mcp?.servers },
            instructions: [...(base.instructions ?? []), ...(entry.info.instructions ?? [])],
          }),
          {},
        )
    })

    const conflictList = Effect.fnUntraced(function* (state: MarketplaceState, listing: MarketplaceListing) {
      const base = yield* rawBase()
      const effective = composeMarketplaceConfig(base, stateWithout(state, listing.key))
      return marketplaceConflicts(effective, listing.item.install)
    })

    const preview = Effect.fn("MarketplaceService.preview")(function* (key: string) {
      yield* MarketplaceOperationContext.phase("resolving")
      const state = yield* registry.read()
      // Consent is bound to catalog metadata, never to the cached image representation sent to the UI.
      const listing = yield* findListing(state, key, false)
      if (!listing) {
        return {
          ok: false,
          reason: "not_found",
          message: `Marketplace item not found: ${key}`,
        } satisfies MarketplacePlanResult
      }
      const resolved = yield* Effect.tryPromise({
        try: (signal) => resolveForeignMarketplacePlan(listing.item.install, cache.fetcher("refresh", signal)),
        catch: (error) => (error instanceof Error ? error.message : String(error)),
      }).pipe(Effect.result)
      if (resolved._tag === "Failure")
        return { ok: false, reason: "materialization", message: resolved.failure } satisfies MarketplacePlanResult
      const preview = { ...listing, item: { ...listing.item, install: resolved.success.plan } }
      const status = marketplaceStatus({ marketplace: state }, listing)
      const conflicts = yield* conflictList(state, preview)
      return {
        ok: true,
        key,
        action: status === "update" ? "update" : "install",
        trust_warning: !trusted(listing.source),
        conflicts,
        permissions: marketplacePermissions(preview.item),
        summary: [marketplacePlanSummary(preview.item.install), ...resolved.success.warnings].join("; "),
        fingerprint: confirmation(preview, conflicts),
      } satisfies MarketplacePlanResult & { fingerprint: string }
    })

    const plan = Effect.fn("MarketplaceService.plan")(function* (key: string) {
      const result = yield* preview(key)
      if (!result.ok) return result
      const { fingerprint: _fingerprint, ...value } = result
      return value
    })

    const findListing = Effect.fnUntraced(function* (state: MarketplaceState, key: string, refresh: boolean) {
      const loaded = yield* Effect.tryPromise({
        try: (signal) =>
          loadMarketplace({
            config: { marketplace: state },
            fetch: cache.fetcher(refresh ? "refresh" : "cache-first", signal),
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
      expectedFingerprint?: string
    }) {
      yield* MarketplaceOperationContext.phase("resolving")
      const resolved = yield* Effect.tryPromise({
        try: (signal) => resolveForeignMarketplacePlan(input.listing.item.install, cache.fetcher("refresh", signal)),
        catch: (error) => (error instanceof Error ? error.message : String(error)),
      }).pipe(Effect.result)
      if (resolved._tag === "Failure")
        return {
          ok: false as const,
          failure: {
            ok: false,
            reason: "materialization",
            message: resolved.failure,
            revision: input.state.revision ?? 0,
          } satisfies MarketplaceMutationResult,
        }
      const installPlan = resolved.success.plan
      yield* MarketplaceOperationContext.phase("checking-conflicts")
      const conflicts = yield* conflictList(input.state, {
        ...input.listing,
        item: { ...input.listing.item, install: installPlan },
      })
      if (
        input.expectedFingerprint !== undefined &&
        input.expectedFingerprint !==
          confirmation({ ...input.listing, item: { ...input.listing.item, install: installPlan } }, conflicts)
      )
        return {
          ok: false as const,
          failure: {
            ok: false,
            reason: "conflict",
            message: "Installation plan, trust or conflicts changed; prepare and confirm it again",
          } satisfies MarketplaceMutationResult,
        }
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

      yield* MarketplaceOperationContext.phase("materializing")
      const materialized = yield* cache.materializePlan(installPlan, input.listing.source).pipe(
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
      const components = marketplaceSkillComponents(installPlan)
      const disabledSkills =
        current?.disabled_skills?.filter((id) => components.some((component) => component.id === id)) ??
        components.filter((component) => component.enabled === false).map((component) => component.id)
      const disabledMcp =
        current?.disabled_mcp?.filter((id) => id in (installPlan.mcp ?? {})) ??
        marketplaceInitialDisabledMcp(installPlan)
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
        plan: clone(installPlan),
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
      key?: string
    }) {
      const operation = yield* MarketplaceOperationContext.Current
      const stored = yield* Effect.gen(function* () {
        if (operation) yield* operation.phase("applying")
        return yield* registry.replace(
          input.state,
          operation
            ? (tx, result) =>
                operation.commit(
                  tx,
                  {
                    revision: result.state.revision ?? 0,
                    changed: result.changed,
                    connect_mcp: Array.from(new Set(input.connectMcp ?? [])).toSorted(),
                  },
                  input.key,
                )
            : undefined,
        )
      }).pipe(
        Effect.uninterruptible,
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      )
      if (!stored.ok) {
        const error = stored.error
        if (error instanceof MarketplaceRegistry.ConflictError) return revisionFailure(error.expected, error.actual)
        return revisionFailure(input.state.revision ?? 0, (yield* registry.read()).revision ?? 0)
      }
      if (stored.value.changed && config.refresh)
        yield* config
          .refresh()
          .pipe(
            Effect.catchCause((cause) =>
              operation
                ? operation
                    .warning("Registry saved, but configuration refresh failed; reload configuration to retry")
                    .pipe(Effect.andThen(Effect.logWarning("Marketplace configuration refresh failed", cause)))
                : Effect.failCause(cause),
            ),
          )
      return {
        ok: true,
        changed: stored.value.changed,
        view: operation
          ? { state: publicState(stored.value.state), listings: [], errors: [], cache: yield* cache.summary() }
          : yield* loadView(stored.value.state, false),
        connect_mcp: Array.from(new Set(input.connectMcp ?? [])).toSorted(),
        preserved: input.preserved ?? [],
      } satisfies MarketplaceMutationResult
    })

    const installListing = Effect.fnUntraced(function* (input: {
      state: MarketplaceState
      listing: MarketplaceListing
      force?: boolean
      acceptUntrusted?: boolean
      expectedFingerprint?: string
    }) {
      const state = input.state
      const listing = input.listing
      const prepared = yield* prepare({
        state,
        listing,
        force: input.force,
        acceptUntrusted: input.acceptUntrusted,
        expectedFingerprint: input.expectedFingerprint,
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
        key: listing.key,
        connectMcp: marketplaceEnabledMcpNames(
          { marketplace: { installed: { [listing.key]: prepared.installed } } },
          listing.key,
        ),
      })
    })

    const install = Effect.fn("MarketplaceService.install")(function* (input: InstallInput) {
      const state = yield* registry.read()
      if ((state.revision ?? 0) !== input.expectedRevision)
        return revisionFailure(input.expectedRevision, state.revision ?? 0)
      const listing = yield* findListing(state, input.key, true)
      if (!listing) return notFound(`Marketplace item not found: ${input.key}`)
      return yield* installListing({ ...input, state, listing })
    })

    const updateAll = Effect.fn("MarketplaceService.updateAll")(function* (input: UpdateAllInput) {
      const state = yield* registry.read()
      if ((state.revision ?? 0) !== input.expectedRevision) {
        return revisionFailure(input.expectedRevision, state.revision ?? 0)
      }
      const loaded = yield* Effect.tryPromise({
        try: (signal) => loadMarketplace({ config: { marketplace: state }, fetch: cache.fetcher("refresh", signal) }),
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
      yield* MarketplaceOperationContext.phase("checking-source")
      const resolved = yield* Effect.promise(() => resolveMarketplaceSourceReference(input.url, location.directory))
      const source = {
        ...createMarketplaceSource({
          url: resolved.local ? resolved.url : resolved.reference,
          name: input.name ?? resolved.name,
          trust: input.trust,
          headers: resolved.local ? undefined : input.headers,
        }),
        reference: resolved.reference,
      }
      const next = upsertMarketplaceSource({ marketplace: state }, source).marketplace ?? state
      yield* registry.recordStatus({ id: source.id, status: "checking" })
      const checked = yield* loadView(next, true)
      const result = yield* persist({ state: next })
      if (result.ok) {
        const operation = yield* MarketplaceOperationContext.Current
        if (operation)
          for (const error of checked.errors.filter((error) => error.source.id === source.id))
            yield* operation.warning(error.message)
      }
      return result
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

    const updatePackages = Effect.fn("MarketplaceService.updatePackages")(function* (
      command: Extract<MarketplaceOperation.Command, { kind: "update-all" }>,
    ) {
      const operation = yield* MarketplaceOperationContext.Current
      if (!operation)
        return yield* Effect.fail({
          code: "invalid-request" as const,
          message: "Bulk updates require the Marketplace worker",
          retryable: false,
        })
      yield* operation.phase("checking-source")
      const state = yield* registry.read()
      const loaded = yield* Effect.tryPromise({
        try: (signal) => loadMarketplace({ config: { marketplace: state }, fetch: cache.fetcher("refresh", signal) }),
        catch: () => ({
          code: "download" as const,
          message: "Could not refresh Marketplace catalogs",
          retryable: true,
        }),
      })
      for (const error of loaded.errors) yield* operation.warning(error.message)
      const candidates = loaded.listings.filter(
        (listing) => marketplaceStatus({ marketplace: state }, listing) === "update",
      )
      const connect = new Set<string>()
      const outcomes = yield* Effect.forEach(candidates, (listing, index) =>
        Effect.gen(function* () {
          const current = yield* registry.read()
          const result = yield* installListing({
            state: current,
            listing,
            force: command.force,
            acceptUntrusted: command.accept_untrusted,
          })
          if (!result.ok) {
            yield* operation.outcome({ key: listing.key, status: "failed", error: operationFailure(result) })
            yield* operation.progress({ completed: index + 1, total: candidates.length, unit: "packages" })
            return false
          }
          result.connect_mcp.forEach((name) => connect.add(name))
          yield* operation.progress({ completed: index + 1, total: candidates.length, unit: "packages" })
          return result.changed
        }),
      )
      return {
        revision: (yield* registry.read()).revision ?? 0,
        changed: outcomes.some(Boolean),
        connect_mcp: Array.from(connect).toSorted(),
      }
    })

    const execute = Effect.fn("MarketplaceService.execute")(function* (command: MarketplaceOperation.Command) {
      if (command.kind === "update-all") return yield* updatePackages(command)
      if (command.kind === "prepare-install") {
        const result = yield* preview(command.key)
        if (!result.ok)
          return yield* Effect.fail({
            code: result.reason === "not_found" ? ("not-found" as const) : ("download" as const),
            message: result.message,
            retryable: true,
          })
        const { fingerprint, ...plan } = result
        return { plan, fingerprint }
      }
      if (command.kind === "refresh") {
        yield* MarketplaceOperationContext.phase("checking-source")
        const view = yield* get({ refresh: true })
        if (view.errors.length)
          return yield* Effect.fail({
            code: "download" as const,
            message: view.errors.map((error) => error.message).join("; "),
            retryable: true,
          })
        return { revision: view.state.revision ?? 0, changed: false }
      }
      if (command.kind === "prune") {
        yield* cachePrune({ maxAgeDays: command.max_age_days })
        return { changed: true }
      }
      const expectedRevision = (yield* registry.read()).revision ?? 0
      const result = yield* (() => {
        switch (command.kind) {
          case "source-add":
            return sourceAdd({ ...command, expectedRevision })
          case "source-remove":
            return sourceRemove({ ...command, expectedRevision })
          case "source-toggle":
            return sourceToggle({ ...command, expectedRevision })
          case "install":
            return install({
              key: command.key,
              expectedRevision,
              expectedFingerprint: command.expected_fingerprint,
              force: command.force,
              acceptUntrusted: command.accept_untrusted,
            })
          case "uninstall":
            return uninstall({ ...command, expectedRevision })
          case "toggle":
            return toggle({ ...command, expectedRevision })
        }
      })()
      if (!result.ok) return yield* Effect.fail(operationFailure(result))
      return { revision: result.view.state.revision ?? 0, changed: result.changed, connect_mcp: result.connect_mcp }
    })

    return Service.of({
      execute,
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

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, Location.node, MarketplaceCache.node, MarketplaceRegistry.node],
})

function confirmation(
  listing: MarketplaceListing,
  conflicts: ReadonlyArray<{ path: string; current: unknown; incoming: unknown }>,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        item: listing.item,
        source: { id: listing.source.id, url: listing.source.url, trust: listing.source.trust },
        conflicts,
      }),
    )
    .digest("hex")
}

function operationFailure(result: Extract<MarketplaceMutationResult, { ok: false }>): MarketplaceOperation.Failure {
  return {
    code:
      result.reason === "not_found"
        ? "not-found"
        : result.reason === "trust"
          ? "trust"
          : result.reason === "materialization"
            ? "download"
            : "conflict",
    message: result.message,
    retryable: result.reason === "materialization",
  }
}
