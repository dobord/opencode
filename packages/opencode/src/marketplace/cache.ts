import path from "path"
import fsNode from "fs/promises"
import { createHash, randomUUID } from "crypto"
import { fileURLToPath, pathToFileURL } from "url"
import { Context, Effect, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Global } from "@opencode-ai/core/global"
import type {
  MarketplaceFetch,
  MarketplaceInstallPlan,
  MarketplacePluginSpec,
  MarketplaceSource,
  MarketplaceSkill,
} from "@opencode-ai/core/marketplace"

export type CacheMode = "cache-first" | "refresh"

export type Artifact = {
  digest: string
  path: string
  size: number
  mediaType?: string
  kind: string
  sourceUrl?: string
}

export type MaterializedPlan = {
  plan: MarketplaceInstallPlan
  artifactDigests: string[]
  treeDigest?: string
}

export type CacheSummary = {
  root: string
  objects: number
  total_bytes: number
  fetch_entries: number
  materializations: number
}

export class CacheError extends Schema.TaggedErrorClass<CacheError>()("MarketplaceCacheError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface Interface {
  readonly put: (
    bytes: Uint8Array,
    metadata?: { mediaType?: string; kind?: string; sourceUrl?: string },
  ) => Effect.Effect<Artifact, CacheError>
  readonly putJson: (
    value: unknown,
    metadata?: { kind?: string; sourceUrl?: string },
  ) => Effect.Effect<Artifact, CacheError>
  readonly fetchResponse: (input: {
    url: string
    headers?: HeadersInit
    signal?: AbortSignal
    kind?: string
    mode?: CacheMode
    source?: MarketplaceSource
  }) => Effect.Effect<Response, CacheError>
  readonly fetcher: (mode?: CacheMode) => MarketplaceFetch
  readonly materializePlan: (
    plan: MarketplaceInstallPlan,
    source: MarketplaceSource,
  ) => Effect.Effect<MaterializedPlan, CacheError>
  readonly summary: () => Effect.Effect<CacheSummary>
  readonly prune: (input: {
    keep?: Iterable<string>
    maxAgeDays?: number
  }) => Effect.Effect<{ removed_objects: number; removed_materializations: number; summary: CacheSummary }, CacheError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MarketplaceCache") {}

type FetchRow = {
  key: string
  url: string
  digest: string
  etag?: string | null
  last_modified?: string | null
  status: number
  time_fetched: number
}

type TreeEntry = {
  relative: string
  bytes: Uint8Array
  digest: string
}

type IndexedSkill = {
  name: string
  files: string[]
  version?: string
}

function hashBytes(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

function digestOf(bytes: Uint8Array) {
  return `sha256:${hashBytes(bytes)}`
}

function digestHex(digest: string) {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(digest)
  if (!match) throw new Error(`Unsupported marketplace digest: ${digest}`)
  return match[1]!.toLowerCase()
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

function cacheError(operation: string, error: unknown) {
  return error instanceof CacheError
    ? error
    : new CacheError({ operation, message: error instanceof Error ? error.message : String(error) })
}

function safeSegment(value: string) {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return cleaned || "item"
}

function safeRelative(value: string) {
  const clean = value.replaceAll("\\", "/").replace(/^\.\/+/, "")
  if (!clean || clean.startsWith("/") || /^[A-Za-z]:\//.test(clean)) throw new Error(`Unsafe artifact path: ${value}`)
  const parts = clean.split("/")
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`Unsafe artifact path: ${value}`)
  return parts.join("/")
}

function headersObject(input?: HeadersInit) {
  const headers = new Headers(input)
  return Object.fromEntries(
    Array.from(headers.entries())
      .map(([key, value]) => [key.toLowerCase(), value] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}

function requestKey(url: string, headers?: HeadersInit) {
  return hashBytes(new TextEncoder().encode(stable({ url, headers: headersObject(headers) })))
}

function sameOriginHeaders(source: MarketplaceSource, target: string) {
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

function localMediaType(target: string) {
  switch (path.extname(target).toLowerCase()) {
    case ".json":
      return "application/json"
    case ".md":
      return "text/markdown; charset=utf-8"
    case ".js":
    case ".mjs":
    case ".cjs":
    case ".ts":
      return "text/javascript; charset=utf-8"
    case ".png":
      return "image/png"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".webp":
      return "image/webp"
    case ".gif":
      return "image/gif"
    default:
      return undefined
  }
}

function isArtifactURL(value: string) {
  return /^(?:https?|file):/i.test(value)
}

function readIndex(value: unknown): IndexedSkill[] {
  if (!value || typeof value !== "object" || !("skills" in value) || !Array.isArray(value.skills)) {
    throw new Error("Skill source index must contain a skills array")
  }
  return value.skills.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`Invalid skill index entry ${index}`)
    const record = entry as Record<string, unknown>
    if (typeof record.name !== "string" || !Array.isArray(record.files)) {
      throw new Error(`Invalid skill index entry ${index}`)
    }
    const files = record.files.map((file) => {
      if (typeof file !== "string") throw new Error(`Invalid skill index file in entry ${index}`)
      return safeRelative(file)
    })
    if (!files.includes("SKILL.md")) throw new Error(`Skill ${record.name} does not contain SKILL.md`)
    return {
      name: record.name,
      files,
      ...(typeof record.version === "string" ? { version: record.version } : {}),
    }
  })
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const flock = yield* EffectFlock.Service
    const root = path.join(Global.Path.cache, "marketplace")
    const objects = path.join(root, "objects", "sha256")
    const materialized = path.join(root, "materialized", "sha256")

    const objectPath = (digest: string) => {
      const hex = digestHex(digest)
      return path.join(objects, hex.slice(0, 2), hex)
    }

    const exists = (target: string) =>
      Effect.tryPromise({
        try: () =>
          fsNode
            .stat(target)
            .then(() => true)
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return false
              throw error
            }),
        catch: (error) => cacheError("stat", error),
      })

    const readBytes = (target: string) =>
      Effect.tryPromise({
        try: () => fsNode.readFile(target).then((value) => new Uint8Array(value)),
        catch: (error) => cacheError("read", error),
      })

    const validateLocalArtifact = Effect.fnUntraced(function* (source: MarketplaceSource | undefined, target: URL) {
      if (target.protocol !== "file:" || !source) return
      const sourceURL = new URL(source.url)
      if (sourceURL.protocol !== "file:") {
        return yield* new CacheError({
          operation: "validate local artifact",
          message: `Network Marketplace source ${source.name} cannot reference local file ${target.href}`,
        })
      }

      const sourcePath = fileURLToPath(sourceURL)
      const rootPath = sourceURL.pathname.endsWith("/") ? sourcePath : path.dirname(sourcePath)
      const targetPath = fileURLToPath(target)
      const [root, candidate] = yield* Effect.tryPromise({
        try: () => Promise.all([fsNode.realpath(rootPath), fsNode.realpath(targetPath)]),
        catch: (error) => cacheError("validate local artifact", error),
      })
      const relative = path.relative(root, candidate)
      if (relative === "") return
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return yield* new CacheError({
          operation: "validate local artifact",
          message: `Local Marketplace artifact escapes its source directory: ${target.href}`,
        })
      }
    })

    const put = Effect.fn("MarketplaceCache.put")(function* (
      bytes: Uint8Array,
      metadata: { mediaType?: string; kind?: string; sourceUrl?: string } = {},
    ) {
      const digest = digestOf(bytes)
      const target = objectPath(digest)
      yield* flock
        .withLock(
          Effect.gen(function* () {
            if (!(yield* exists(target))) {
              const staging = `${target}.tmp-${randomUUID()}`
              yield* Effect.tryPromise({
                try: async () => {
                  await fsNode.mkdir(path.dirname(target), { recursive: true })
                  await fsNode.writeFile(staging, bytes, { mode: 0o600 })
                  await fsNode.rename(staging, target).catch(async (error: NodeJS.ErrnoException) => {
                    if (error.code !== "EEXIST") throw error
                  })
                  await fsNode.rm(staging, { force: true })
                },
                catch: (error) => cacheError("put", error),
              })
            }

            const now = Date.now()
            yield* db
              .run(
                sql`
                INSERT INTO marketplace_artifact
                  (digest, size, media_type, kind, source_url, time_created, time_accessed)
                VALUES
                  (${digest}, ${bytes.byteLength}, ${metadata.mediaType ?? null}, ${metadata.kind ?? "blob"},
                   ${metadata.sourceUrl ?? null}, ${now}, ${now})
                ON CONFLICT(digest) DO UPDATE SET
                  time_accessed = excluded.time_accessed,
                  media_type = COALESCE(marketplace_artifact.media_type, excluded.media_type),
                  source_url = COALESCE(marketplace_artifact.source_url, excluded.source_url)
              `,
              )
              .pipe(Effect.orDie)
          }),
          `marketplace-artifact:${digest}`,
        )
        .pipe(Effect.mapError((error) => cacheError("lock", error)))

      return {
        digest,
        path: target,
        size: bytes.byteLength,
        ...(metadata.mediaType ? { mediaType: metadata.mediaType } : {}),
        kind: metadata.kind ?? "blob",
        ...(metadata.sourceUrl ? { sourceUrl: metadata.sourceUrl } : {}),
      } satisfies Artifact
    })

    const putJson = Effect.fn("MarketplaceCache.putJson")(function* (
      value: unknown,
      metadata: { kind?: string; sourceUrl?: string } = {},
    ) {
      return yield* put(new TextEncoder().encode(stable(value)), {
        mediaType: "application/json",
        kind: metadata.kind ?? "json",
        sourceUrl: metadata.sourceUrl,
      })
    })

    const cached = Effect.fnUntraced(function* (row: FetchRow | undefined) {
      if (!row) return undefined
      const target = objectPath(row.digest)
      if (!(yield* exists(target))) return undefined
      const bytes = yield* readBytes(target)
      const artifact = (yield* db
        .all<{
          media_type?: string | null
        }>(sql`SELECT media_type FROM marketplace_artifact WHERE digest = ${row.digest} LIMIT 1`)
        .pipe(Effect.orDie))[0]
      yield* db
        .run(sql`UPDATE marketplace_artifact SET time_accessed = ${Date.now()} WHERE digest = ${row.digest}`)
        .pipe(Effect.orDie)
      return { bytes, mediaType: artifact?.media_type ?? undefined }
    })

    const fetchResponse = Effect.fn("MarketplaceCache.fetchResponse")(function* (input: {
      url: string
      headers?: HeadersInit
      signal?: AbortSignal
      kind?: string
      mode?: CacheMode
      source?: MarketplaceSource
    }) {
      const parsed = new URL(input.url)
      yield* validateLocalArtifact(input.source, parsed)
      const url = parsed.href
      const key = requestKey(url, input.headers)
      const row = (yield* db
        .all<FetchRow>(sql`SELECT * FROM marketplace_fetch WHERE key = ${key} LIMIT 1`)
        .pipe(Effect.orDie))[0]
      const hit = yield* cached(row)

      if (hit && input.mode !== "refresh") {
        return new Response(hit.bytes, {
          status: 200,
          headers: {
            ...(hit.mediaType ? { "content-type": hit.mediaType } : {}),
            "content-length": String(hit.bytes.byteLength),
            "x-opencode-artifact-digest": row!.digest,
            "x-opencode-cache": "hit",
          },
        })
      }

      if (parsed.protocol === "file:") {
        const local = yield* Effect.tryPromise({
          try: async () => {
            const target = fileURLToPath(parsed)
            const [buffer, stat] = await Promise.all([fsNode.readFile(target), fsNode.stat(target)])
            return {
              bytes: new Uint8Array(buffer),
              mediaType: localMediaType(target),
              lastModified: stat.mtime.toUTCString(),
            }
          },
          catch: (error) => cacheError("read local source", error),
        }).pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
        )

        if (!local.ok) {
          if (hit && row) {
            return new Response(hit.bytes, {
              status: 200,
              headers: {
                ...(hit.mediaType ? { "content-type": hit.mediaType } : {}),
                "content-length": String(hit.bytes.byteLength),
                "x-opencode-artifact-digest": row.digest,
                "x-opencode-cache": "stale",
              },
            })
          }
          return yield* local.error
        }

        const artifact = yield* put(local.value.bytes, {
          mediaType: local.value.mediaType,
          kind: input.kind ?? "local",
          sourceUrl: url,
        })
        const now = Date.now()
        yield* db
          .run(
            sql`
            INSERT INTO marketplace_fetch (key, url, digest, etag, last_modified, status, time_fetched)
            VALUES (${key}, ${url}, ${artifact.digest}, ${null}, ${local.value.lastModified}, ${200}, ${now})
            ON CONFLICT(key) DO UPDATE SET
              url = excluded.url,
              digest = excluded.digest,
              etag = excluded.etag,
              last_modified = excluded.last_modified,
              status = excluded.status,
              time_fetched = excluded.time_fetched
          `,
          )
          .pipe(Effect.orDie)

        return new Response(local.value.bytes, {
          status: 200,
          headers: {
            ...(local.value.mediaType ? { "content-type": local.value.mediaType } : {}),
            "content-length": String(local.value.bytes.byteLength),
            "last-modified": local.value.lastModified,
            "x-opencode-artifact-digest": artifact.digest,
            "x-opencode-cache": "miss",
          },
        })
      }

      const headers = new Headers(input.headers)
      if (row?.etag) headers.set("if-none-match", row.etag)
      if (row?.last_modified) headers.set("if-modified-since", row.last_modified)

      const attempt = yield* Effect.tryPromise({
        try: () => globalThis.fetch(url, { headers, signal: input.signal }),
        catch: (error) => cacheError("fetch", error),
      }).pipe(
        Effect.map((response) => ({ ok: true as const, response })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      )

      if (!attempt.ok) {
        if (hit) {
          return new Response(hit.bytes, {
            status: 200,
            headers: {
              ...(hit.mediaType ? { "content-type": hit.mediaType } : {}),
              "content-length": String(hit.bytes.byteLength),
              "x-opencode-artifact-digest": row!.digest,
              "x-opencode-cache": "stale",
            },
          })
        }
        return yield* attempt.error
      }

      const response = attempt.response
      if (response.status === 304 && hit && row) {
        yield* db
          .run(sql`UPDATE marketplace_fetch SET time_fetched = ${Date.now()} WHERE key = ${key}`)
          .pipe(Effect.orDie)
        return new Response(hit.bytes, {
          status: 200,
          headers: {
            ...(hit.mediaType ? { "content-type": hit.mediaType } : {}),
            "content-length": String(hit.bytes.byteLength),
            "x-opencode-artifact-digest": row.digest,
            "x-opencode-cache": "revalidated",
          },
        })
      }

      if (!response.ok) {
        if (hit && row) {
          return new Response(hit.bytes, {
            status: 200,
            headers: {
              ...(hit.mediaType ? { "content-type": hit.mediaType } : {}),
              "content-length": String(hit.bytes.byteLength),
              "x-opencode-artifact-digest": row.digest,
              "x-opencode-cache": "stale",
            },
          })
        }
        return yield* new CacheError({
          operation: "fetch",
          message: `HTTP ${response.status} ${response.statusText} for ${url}`,
        })
      }

      const bytes = yield* Effect.tryPromise({
        try: () => response.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
        catch: (error) => cacheError("read response", error),
      })
      const mediaType = response.headers.get("content-type") ?? undefined
      const artifact = yield* put(bytes, { mediaType, kind: input.kind ?? "remote", sourceUrl: url })
      const now = Date.now()
      yield* db
        .run(
          sql`
          INSERT INTO marketplace_fetch (key, url, digest, etag, last_modified, status, time_fetched)
          VALUES (${key}, ${url}, ${artifact.digest}, ${response.headers.get("etag")},
                  ${response.headers.get("last-modified")}, ${response.status}, ${now})
          ON CONFLICT(key) DO UPDATE SET
            url = excluded.url,
            digest = excluded.digest,
            etag = excluded.etag,
            last_modified = excluded.last_modified,
            status = excluded.status,
            time_fetched = excluded.time_fetched
        `,
        )
        .pipe(Effect.orDie)

      return new Response(bytes, {
        status: 200,
        headers: {
          ...(mediaType ? { "content-type": mediaType } : {}),
          "content-length": String(bytes.byteLength),
          "x-opencode-artifact-digest": artifact.digest,
          "x-opencode-cache": "miss",
        },
      })
    })

    const fetchArtifact = Effect.fnUntraced(function* (input: {
      url: string
      headers?: HeadersInit
      kind: string
      source: MarketplaceSource
    }) {
      const response = yield* fetchResponse({ ...input, mode: "refresh" })
      const bytes = yield* Effect.tryPromise({
        try: () => response.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
        catch: (error) => cacheError("read cached response", error),
      })
      const digest = response.headers.get("x-opencode-artifact-digest")
      if (!digest) return yield* new CacheError({ operation: "fetch", message: `Missing digest for ${input.url}` })
      return { bytes, digest, mediaType: response.headers.get("content-type") ?? undefined }
    })

    const fetcher = (mode: CacheMode = "cache-first"): MarketplaceFetch => {
      return async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init)
        return Effect.runPromise(
          fetchResponse({
            url: request.url,
            headers: request.headers,
            signal: request.signal,
            kind: "catalog",
            mode,
          }),
        )
      }
    }

    const indexedSkill = Effect.fnUntraced(function* (input: {
      url: string
      source: MarketplaceSource
      prefix: string
      name?: string
      entries: Map<string, TreeEntry>
      digests: Set<string>
    }) {
      const base = input.url.endsWith("/") ? input.url : `${input.url}/`
      const indexURL = new URL("index.json", base).href
      const headers = sameOriginHeaders(input.source, indexURL)
      const indexArtifact = yield* fetchArtifact({ url: indexURL, headers, kind: "skill-index", source: input.source })
      input.digests.add(indexArtifact.digest)
      const index = yield* Effect.try({
        try: () => readIndex(JSON.parse(new TextDecoder().decode(indexArtifact.bytes))),
        catch: (error) => cacheError("parse skill index", error),
      })
      const selected = input.name ? index.filter((skill) => skill.name === input.name) : index
      if (selected.length === 0) {
        return yield* new CacheError({
          operation: "materialize skill",
          message: `Skill ${input.name} is not present in ${indexURL}`,
        })
      }

      const roots: Array<{ name: string; relative: string }> = []
      for (const skill of selected) {
        const skillRoot = path.posix.join(input.prefix, safeSegment(skill.name))
        for (const file of skill.files) {
          const url = new URL(file, `${base}${encodeURIComponent(skill.name)}/`).href
          const artifact = yield* fetchArtifact({
            url,
            headers: sameOriginHeaders(input.source, url),
            kind: "skill-file",
            source: input.source,
          })
          input.digests.add(artifact.digest)
          const relative = path.posix.join(skillRoot, safeRelative(file))
          input.entries.set(relative, { relative, bytes: artifact.bytes, digest: artifact.digest })
        }
        roots.push({ name: skill.name, relative: skillRoot })
      }
      return roots
    })

    const directSkillSource = Effect.fnUntraced(function* (input: {
      url: string
      source: MarketplaceSource
      prefix: string
      name: string
      entries: Map<string, TreeEntry>
      digests: Set<string>
    }) {
      const base = input.url.endsWith("/") ? input.url : `${input.url}/`
      const url = new URL("SKILL.md", base).href
      const artifact = yield* fetchArtifact({
        url,
        headers: sameOriginHeaders(input.source, url),
        kind: "skill-file",
        source: input.source,
      })
      input.digests.add(artifact.digest)
      const root = path.posix.join(input.prefix, safeSegment(input.name))
      const relative = path.posix.join(root, "SKILL.md")
      input.entries.set(relative, { relative, bytes: artifact.bytes, digest: artifact.digest })
      return [{ name: input.name, relative: root }]
    })

    const directSkill = Effect.fnUntraced(function* (input: {
      item: MarketplaceSkill
      source: MarketplaceSource
      prefix: string
      entries: Map<string, TreeEntry>
      digests: Set<string>
    }) {
      const configured = input.item.url!
      const url = configured.endsWith("/") ? new URL("SKILL.md", configured).href : configured
      const artifact = yield* fetchArtifact({
        url,
        headers: sameOriginHeaders(input.source, url),
        kind: "skill-file",
        source: input.source,
      })
      input.digests.add(artifact.digest)
      const root = path.posix.join(input.prefix, safeSegment(input.item.id || input.item.name))
      const relative = path.posix.join(root, "SKILL.md")
      input.entries.set(relative, { relative, bytes: artifact.bytes, digest: artifact.digest })
      return { name: input.item.name, relative: root }
    })

    const materializePlan = Effect.fn("MarketplaceCache.materializePlan")(function* (
      inputPlan: MarketplaceInstallPlan,
      source: MarketplaceSource,
    ) {
      const plan = clone(inputPlan)
      const entries = new Map<string, TreeEntry>()
      const digests = new Set<string>()
      const legacyRoots: string[] = []
      const itemRoots = new Map<string, string>()
      const pluginRelatives = new Map<number, string>()

      for (const [index, plugin] of (plan.plugins ?? []).entries()) {
        const spec = Array.isArray(plugin) ? plugin[0] : plugin
        if (!isArtifactURL(spec)) continue
        const artifact = yield* fetchArtifact({
          url: spec,
          headers: sameOriginHeaders(source, spec),
          kind: "plugin-file",
          source,
        })
        digests.add(artifact.digest)
        const basename = safeSegment(path.posix.basename(new URL(spec).pathname) || `plugin-${index}.js`)
        const relative = path.posix.join("plugins", `${index}-${basename}`)
        entries.set(relative, { relative, bytes: artifact.bytes, digest: artifact.digest })
        pluginRelatives.set(index, relative)
      }

      for (const [index, url] of (plan.skills?.urls ?? []).entries()) {
        const prefix = path.posix.join("skills", `source-${index}`)
        const roots = yield* indexedSkill({
          url,
          source,
          prefix,
          entries,
          digests,
        }).pipe(
          Effect.catch(() =>
            directSkillSource({
              url,
              source,
              prefix,
              name: `source-${index}`,
              entries,
              digests,
            }),
          ),
        )
        legacyRoots.push(...roots.map((root) => root.relative))
      }

      for (const item of plan.skills?.items ?? []) {
        if (!item.url) continue
        const indexed = yield* indexedSkill({
          url: item.url,
          source,
          prefix: path.posix.join("skills", `item-${safeSegment(item.id)}`),
          name: item.name,
          entries,
          digests,
        }).pipe(
          Effect.map((roots) => ({ ok: true as const, roots })),
          Effect.catch(() =>
            directSkill({
              item,
              source,
              prefix: path.posix.join("skills", `item-${safeSegment(item.id)}`),
              entries,
              digests,
            }).pipe(Effect.map((root) => ({ ok: true as const, roots: [root] }))),
          ),
        )
        const root = indexed.roots[0]
        if (root) itemRoots.set(item.id, root.relative)
      }

      const instructionRelatives = new Map<number, string>()
      for (const [index, instruction] of (plan.instructions ?? []).entries()) {
        if (!isArtifactURL(instruction)) continue
        const url = new URL(instruction).href
        const artifact = yield* fetchArtifact({
          url,
          headers: sameOriginHeaders(source, url),
          kind: "instruction",
          source,
        })
        digests.add(artifact.digest)
        const basename = safeSegment(path.posix.basename(new URL(url).pathname) || `instruction-${index}.md`)
        const relative = path.posix.join("instructions", `${index}-${basename}`)
        entries.set(relative, { relative, bytes: artifact.bytes, digest: artifact.digest })
        instructionRelatives.set(index, relative)
      }

      if (entries.size === 0) {
        return { plan, artifactDigests: Array.from(digests).toSorted() } satisfies MaterializedPlan
      }

      const manifest = Array.from(entries.values())
        .map((entry) => ({ path: entry.relative, digest: entry.digest }))
        .toSorted((left, right) => left.path.localeCompare(right.path))
      const treeDigest = digestOf(new TextEncoder().encode(stable(manifest)))
      const hex = digestHex(treeDigest)
      const target = path.join(materialized, hex.slice(0, 2), hex)

      yield* flock
        .withLock(
          Effect.gen(function* () {
            if (!(yield* exists(target))) {
              const staging = `${target}.tmp-${randomUUID()}`
              yield* Effect.tryPromise({
                try: async () => {
                  for (const entry of entries.values()) {
                    const file = path.join(staging, ...entry.relative.split("/"))
                    await fsNode.mkdir(path.dirname(file), { recursive: true })
                    await fsNode.writeFile(file, entry.bytes, { mode: 0o600 })
                  }
                  await fsNode.mkdir(path.dirname(target), { recursive: true })
                  await fsNode.rename(staging, target).catch(async (error: NodeJS.ErrnoException) => {
                    if (error.code !== "EEXIST") throw error
                  })
                  await fsNode.rm(staging, { recursive: true, force: true })
                },
                catch: (error) => cacheError("materialize", error),
              })
            }

            const now = Date.now()
            yield* db
              .run(
                sql`
                INSERT INTO marketplace_materialization
                  (digest, path, artifacts, time_created, time_accessed)
                VALUES (${treeDigest}, ${target}, ${JSON.stringify(Array.from(digests).toSorted())}, ${now}, ${now})
                ON CONFLICT(digest) DO UPDATE SET time_accessed = excluded.time_accessed
              `,
              )
              .pipe(Effect.orDie)
          }),
          `marketplace-materialization:${treeDigest}`,
        )
        .pipe(Effect.mapError((error) => cacheError("materialize lock", error)))

      if (plan.plugins && pluginRelatives.size) {
        plan.plugins = plan.plugins.map((plugin, index) => {
          const relative = pluginRelatives.get(index)
          if (!relative) return plugin
          const spec = pathToFileURL(path.join(target, ...relative.split("/"))).href
          return (Array.isArray(plugin) ? [spec, clone(plugin[1])] : spec) as MarketplacePluginSpec
        })
      }

      if (plan.skills) {
        const existing = plan.skills.paths ?? []
        plan.skills.paths = Array.from(
          new Set([...existing, ...legacyRoots.map((relative) => path.join(target, ...relative.split("/")))]),
        )
        delete plan.skills.urls
        if (plan.skills.items) {
          plan.skills.items = plan.skills.items.map((item) => {
            const relative = itemRoots.get(item.id)
            if (!relative) return item
            const next = { ...item, path: path.join(target, ...relative.split("/")) }
            delete next.url
            return next
          })
        }
      }

      if (plan.instructions) {
        plan.instructions = plan.instructions.map((instruction, index) => {
          const relative = instructionRelatives.get(index)
          return relative ? path.join(target, ...relative.split("/")) : instruction
        })
      }

      return {
        plan,
        artifactDigests: Array.from(digests).toSorted(),
        treeDigest,
      } satisfies MaterializedPlan
    })

    const summary = Effect.fn("MarketplaceCache.summary")(function* () {
      const artifact = (yield* db
        .all<{
          objects: number
          total_bytes: number
        }>(sql`SELECT COUNT(*) AS objects, COALESCE(SUM(size), 0) AS total_bytes FROM marketplace_artifact`)
        .pipe(Effect.orDie))[0] ?? { objects: 0, total_bytes: 0 }
      const fetches =
        (yield* db.all<{ count: number }>(sql`SELECT COUNT(*) AS count FROM marketplace_fetch`).pipe(Effect.orDie))[0]
          ?.count ?? 0
      const trees =
        (yield* db
          .all<{ count: number }>(sql`SELECT COUNT(*) AS count FROM marketplace_materialization`)
          .pipe(Effect.orDie))[0]?.count ?? 0
      return {
        root,
        objects: Number(artifact.objects),
        total_bytes: Number(artifact.total_bytes),
        fetch_entries: Number(fetches),
        materializations: Number(trees),
      }
    })

    const prune = Effect.fn("MarketplaceCache.prune")(function* (input: {
      keep?: Iterable<string>
      maxAgeDays?: number
    }) {
      const keep = new Set(input.keep ?? [])
      const cutoff = Date.now() - Math.max(0, input.maxAgeDays ?? 30) * 24 * 60 * 60 * 1000
      const artifacts = yield* db
        .all<{
          digest: string
          time_accessed: number
        }>(sql`SELECT digest, time_accessed FROM marketplace_artifact WHERE time_accessed < ${cutoff}`)
        .pipe(Effect.orDie)
      const trees = yield* db
        .all<{
          digest: string
          path: string
          time_accessed: number
        }>(sql`SELECT digest, path, time_accessed FROM marketplace_materialization WHERE time_accessed < ${cutoff}`)
        .pipe(Effect.orDie)

      let removedObjects = 0
      for (const artifact of artifacts) {
        if (keep.has(artifact.digest)) continue
        yield* Effect.tryPromise({
          try: () => fsNode.rm(objectPath(artifact.digest), { force: true }),
          catch: (error) => cacheError("prune object", error),
        })
        yield* db.run(sql`DELETE FROM marketplace_artifact WHERE digest = ${artifact.digest}`).pipe(Effect.orDie)
        removedObjects++
      }

      let removedMaterializations = 0
      for (const tree of trees) {
        if (keep.has(tree.digest)) continue
        yield* Effect.tryPromise({
          try: () => fsNode.rm(tree.path, { recursive: true, force: true }),
          catch: (error) => cacheError("prune materialization", error),
        })
        yield* db.run(sql`DELETE FROM marketplace_materialization WHERE digest = ${tree.digest}`).pipe(Effect.orDie)
        removedMaterializations++
      }

      return {
        removed_objects: removedObjects,
        removed_materializations: removedMaterializations,
        summary: yield* summary(),
      }
    })

    return Service.of({
      put,
      putJson,
      fetchResponse,
      fetcher,
      materializePlan,
      summary,
      prune,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, EffectFlock.node],
})
