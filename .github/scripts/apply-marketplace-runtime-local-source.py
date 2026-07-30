from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    content = read(path)
    actual = content.count(old)
    if actual != count:
        raise RuntimeError(f"{path}: expected {count} occurrences, found {actual}: {old[:120]!r}")
    write(path, content.replace(old, new, count))


def insert_before(path: str, marker: str, addition: str) -> None:
    content = read(path)
    if marker not in content:
        raise RuntimeError(f"{path}: marker not found: {marker!r}")
    write(path, content.replace(marker, addition + marker, 1))


# ---------------------------------------------------------------------------
# Core catalog support: file: sources, directory catalogs, and catalog-relative
# executable/instruction/skill assets.
# ---------------------------------------------------------------------------
replace(
    "packages/core/src/marketplace.ts",
    "const catalog = resolveCatalogIcons(parseMarketplaceCatalog(await readCatalogResponse(response)), url)",
    "const catalog = resolveCatalogAssets(parseMarketplaceCatalog(await readCatalogResponse(response)), url)",
)

replace(
    "packages/core/src/marketplace.ts",
    '''  const parsed = new URL(url)
  if (parsed.username || parsed.password) throw new Error("Marketplace source URLs cannot contain credentials")
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Marketplace sources must use HTTPS, HTTP, github:, or builtin:")
  }
  if (parsed.protocol === "http:" && !isLoopback(parsed.hostname)) {
    throw new Error("Marketplace sources must use HTTPS; HTTP is only allowed for loopback development servers")
  }
  // Fragments are never sent to a server and make the same catalog hash to
  // multiple source IDs, so canonicalize them away.
  parsed.hash = ""
  if (parsed.hostname === "github.com") {''',
    '''  const parsed = new URL(url)
  if (parsed.username || parsed.password) throw new Error("Marketplace source URLs cannot contain credentials")
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:" && parsed.protocol !== "file:") {
    throw new Error("Marketplace sources must use HTTPS, loopback HTTP, file:, github:, or builtin:")
  }
  if (parsed.protocol === "http:" && !isLoopback(parsed.hostname)) {
    throw new Error("Marketplace sources must use HTTPS; HTTP is only allowed for loopback development servers")
  }
  // Fragments are never sent to a server and make the same catalog hash to
  // multiple source IDs, so canonicalize them away. Local files do not use a
  // query string either, and stripping it keeps one canonical registry key per file.
  parsed.hash = ""
  if (parsed.protocol === "file:") {
    parsed.search = ""
    return parsed.href
  }
  if (parsed.hostname === "github.com") {''',
)

replace(
    "packages/core/src/marketplace.ts",
    '''function marketplaceCatalogURLs(value: string) {
  const source = normalizeMarketplaceURL(value)
  if (!source.endsWith(".git")) return [source]
  const url = new URL(source)
  const repository = `${url.origin}${url.pathname.slice(0, -".git".length)}`''',
    '''function marketplaceCatalogURLs(value: string) {
  const source = normalizeMarketplaceURL(value)
  const url = new URL(source)
  if (url.protocol === "file:" && url.pathname.endsWith("/")) {
    return [new URL(".opencode/marketplace.json", url).href, new URL("marketplace.json", url).href]
  }
  if (!source.endsWith(".git")) return [source]
  const repository = `${url.origin}${url.pathname.slice(0, -".git".length)}`''',
)

replace(
    "packages/core/src/marketplace.ts",
    '''function resolveCatalogIcons(catalog: MarketplaceCatalog, source: string): MarketplaceCatalog {
  return {
    ...catalog,
    items: catalog.items.map((item) => {
      if (!item.icon) return item
      return {
        ...item,
        icon: {
          "src-light": resolveIconAsset(item.icon["src-light"], source),
          ...(item.icon["src-dark"] ? { "src-dark": resolveIconAsset(item.icon["src-dark"], source) } : {}),
        },
      }
    }),
  }
}

function resolveIconAsset(value: string, source: string) {
  if (!value.startsWith("./")) return value
  return new URL(value, normalizeMarketplaceURL(source)).href
}
''',
    '''function resolveCatalogAssets(catalog: MarketplaceCatalog, source: string): MarketplaceCatalog {
  const base = normalizeMarketplaceURL(source)
  return {
    ...catalog,
    items: catalog.items.map((item) => ({
      ...item,
      ...(item.icon
        ? {
            icon: {
              "src-light": resolveCatalogAsset(item.icon["src-light"], base, "catalog item icon"),
              ...(item.icon["src-dark"]
                ? { "src-dark": resolveCatalogAsset(item.icon["src-dark"], base, "catalog item icon") }
                : {}),
            },
          }
        : {}),
      install: resolveCatalogPlan(item.install, base),
    })),
  }
}

function resolveCatalogPlan(plan: MarketplaceInstallPlan, source: string): MarketplaceInstallPlan {
  const plugins = plan.plugins?.map((plugin, index) => resolveCatalogPlugin(plugin, source, index))
  const relativeSkillPaths = (plan.skills?.paths ?? []).filter((value) => value.startsWith("./"))
  const skillPaths = (plan.skills?.paths ?? []).filter((value) => !value.startsWith("./"))
  const skillURLs = Array.from(
    new Set([
      ...(plan.skills?.urls ?? []).map((value, index) =>
        resolveCatalogAsset(value, source, `install.skills.urls[${index}]`, true),
      ),
      ...relativeSkillPaths.map((value, index) =>
        resolveCatalogAsset(value, source, `install.skills.paths[${index}]`, true),
      ),
    ]),
  )
  const skillItems = (plan.skills?.items ?? []).map((item, index) => resolveCatalogSkill(item, source, index))

  return {
    ...clone(plan),
    ...(plugins ? { plugins } : {}),
    ...(plan.skills
      ? {
          skills: {
            ...(skillPaths.length ? { paths: skillPaths } : {}),
            ...(skillURLs.length ? { urls: skillURLs } : {}),
            ...(skillItems.length ? { items: skillItems } : {}),
          },
        }
      : {}),
    ...(plan.instructions
      ? {
          instructions: plan.instructions.map((value, index) =>
            resolveCatalogAsset(value, source, `install.instructions[${index}]`),
          ),
        }
      : {}),
  }
}

function resolveCatalogPlugin(plugin: MarketplacePluginSpec, source: string, index: number): MarketplacePluginSpec {
  const spec = Array.isArray(plugin) ? plugin[0] : plugin
  const resolved = resolveCatalogAsset(spec, source, `install.plugins[${index}]`)
  return Array.isArray(plugin) ? [resolved, clone(plugin[1])] : resolved
}

function resolveCatalogSkill(item: MarketplaceSkill, source: string, index: number): MarketplaceSkill {
  if (item.path?.startsWith("./")) {
    const { path: _path, ...rest } = item
    return {
      ...rest,
      url: resolveCatalogAsset(item.path, source, `install.skills.items[${index}].path`, true),
    }
  }
  if (!item.url) return clone(item)
  return {
    ...clone(item),
    url: resolveCatalogAsset(item.url, source, `install.skills.items[${index}].url`, item.url.endsWith("/")),
  }
}

function resolveCatalogAsset(value: string, source: string, label: string, directory = false) {
  if (!value.startsWith("./")) return value
  const pathname = value.split(/[?#]/)[0] ?? value
  if (value.includes("\\") || pathname.split("/").includes("..")) {
    throw new Error(`${label} must stay inside the catalog directory`)
  }
  const relative = directory && !pathname.endsWith("/") ? `${pathname}/${value.slice(pathname.length)}` : value
  return new URL(relative, source).href
}
''',
)

replace(
    "packages/core/src/marketplace.ts",
    '''function sourceHost(value: string) {
  if (value.startsWith("builtin://")) return value.slice("builtin://".length)
  try {
    return new URL(value).hostname
  } catch {
    return ""
  }
}
''',
    '''function sourceHost(value: string) {
  if (value.startsWith("builtin://")) return value.slice("builtin://".length)
  try {
    const url = new URL(value)
    if (url.protocol !== "file:") return url.hostname
    const parts = decodeURIComponent(url.pathname).split("/").filter(Boolean)
    return parts.at(-1) ?? url.hostname
  } catch {
    return ""
  }
}
''',
)

# Core tests for local directory discovery and relative assets.
insert_before(
    "packages/core/test/marketplace.test.ts",
    '  test("discovers a catalog from a Git repository URL", async () => {',
    '''  test("loads a local directory catalog and resolves catalog-relative assets", async () => {
    const source = createMarketplaceSource({ url: "file:///tmp/team-marketplace/", name: "Local team" })
    const requests: string[] = []
    const result = await loadMarketplace({
      config: upsertMarketplaceSource({}, source),
      fetch: async (input) => {
        const url = String(input)
        requests.push(url)
        if (url.endsWith("/.opencode/marketplace.json")) return new Response("not found", { status: 404 })
        return Response.json({
          schema: "opencode.marketplace/v1",
          id: "local",
          name: "Local",
          items: [
            {
              id: "review",
              name: "Review",
              description: "Local bundle",
              kind: "bundle",
              version: "1.0.0",
              install: {
                plugins: ["./plugins/review.ts"],
                skills: {
                  paths: ["./skills/legacy"],
                  items: [
                    { id: "review", name: "review", path: "./skills/review" },
                    { id: "release", name: "release", url: "./skills/release/SKILL.md" },
                  ],
                },
                instructions: ["./instructions/review.md"],
              },
            },
          ],
        })
      },
    })

    expect(result.errors).toEqual([])
    expect(requests).toContain("file:///tmp/team-marketplace/.opencode/marketplace.json")
    expect(requests).toContain("file:///tmp/team-marketplace/marketplace.json")
    expect(result.listings[0]?.item.install).toEqual({
      plugins: ["file:///tmp/team-marketplace/plugins/review.ts"],
      skills: {
        urls: ["file:///tmp/team-marketplace/skills/legacy/"],
        items: [
          { id: "review", name: "review", url: "file:///tmp/team-marketplace/skills/review/" },
          { id: "release", name: "release", url: "file:///tmp/team-marketplace/skills/release/SKILL.md" },
        ],
      },
      instructions: ["file:///tmp/team-marketplace/instructions/review.md"],
    })
  })

''',
)

# ---------------------------------------------------------------------------
# Node-side source normalization for POSIX paths, Windows drive/UNC paths,
# file URLs, home expansion, and directory catalog conventions.
# ---------------------------------------------------------------------------
write(
    "packages/opencode/src/marketplace/source.ts",
    '''import fs from "fs/promises"
import os from "os"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { normalizeMarketplaceURL } from "@opencode-ai/core/marketplace"

const WINDOWS_DRIVE = /^[A-Za-z]:[\\\\/]/
const WINDOWS_UNC = /^(?:\\\\\\\\|\\/\\/)[^\\\\/]+[\\\\/][^\\\\/]+/
const URI_SCHEME = /^[A-Za-z][A-Za-z\\d+.-]*:/

export type MarketplaceSourceReference = {
  url: string
  reference: string
  local: boolean
  name?: string
}

function expandHome(value: string) {
  if (value === "~") return os.homedir()
  if (value.startsWith("~/") || value.startsWith("~\\\\")) return path.join(os.homedir(), value.slice(2))
  return value
}

function isFileReference(value: string) {
  if (value.startsWith("file:")) return true
  if (WINDOWS_DRIVE.test(value) || WINDOWS_UNC.test(value)) return true
  return !URI_SCHEME.test(value)
}

function localName(target: string, directory: boolean) {
  if (directory) return path.basename(target) || "Local marketplace"
  const filename = path.basename(target)
  if (/^marketplace\\.json$/i.test(filename)) return path.basename(path.dirname(target)) || "Local marketplace"
  return path.basename(target, path.extname(target)) || filename || "Local marketplace"
}

export async function resolveMarketplaceSourceReference(
  value: string,
  cwd = process.cwd(),
): Promise<MarketplaceSourceReference> {
  const reference = value.trim()
  if (!reference) throw new Error("Marketplace catalog URL or path is required")
  if (!isFileReference(reference)) {
    return {
      url: normalizeMarketplaceURL(reference),
      reference,
      local: false,
    }
  }

  const url = reference.startsWith("file:")
    ? new URL(normalizeMarketplaceURL(reference))
    : pathToFileURL(path.resolve(cwd, expandHome(reference)))

  let target: string | undefined
  let directory = reference.endsWith("/") || reference.endsWith("\\\\") || url.pathname.endsWith("/")
  try {
    target = fileURLToPath(url)
    const stat = await fs.stat(target)
    directory = stat.isDirectory()
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined
    if (code !== "ENOENT" && code !== "ENOTDIR" && target !== undefined) throw error
  }

  if (directory && !url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`
  const normalized = normalizeMarketplaceURL(url.href)
  return {
    url: normalized,
    reference,
    local: true,
    ...(target ? { name: localName(target, directory) } : {}),
  }
}
''',
)

write(
    "packages/opencode/test/marketplace/source.test.ts",
    '''import fs from "fs/promises"
import os from "os"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { describe, expect, test } from "bun:test"
import { resolveMarketplaceSourceReference } from "@/marketplace/source"

describe("marketplace local source references", () => {
  test("normalizes files, directories, relative paths, and file URLs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-marketplace-source-"))
    try {
      const catalog = path.join(root, "marketplace.json")
      const directory = path.join(root, "team")
      await fs.writeFile(catalog, "{}")
      await fs.mkdir(directory)

      const file = await resolveMarketplaceSourceReference(catalog)
      expect(file.local).toBe(true)
      expect(file.reference).toBe(catalog)
      expect(fileURLToPath(file.url)).toBe(catalog)

      const dir = await resolveMarketplaceSourceReference(directory)
      expect(dir.local).toBe(true)
      expect(dir.url.endsWith("/")).toBe(true)
      expect(fileURLToPath(dir.url)).toBe(`${directory}${path.sep}`)

      const relative = await resolveMarketplaceSourceReference("./marketplace.json", root)
      expect(fileURLToPath(relative.url)).toBe(catalog)

      const fromURL = await resolveMarketplaceSourceReference(pathToFileURL(catalog).href)
      expect(fileURLToPath(fromURL.url)).toBe(catalog)

      const remote = await resolveMarketplaceSourceReference("https://example.test/marketplace.json")
      expect(remote).toEqual({
        url: "https://example.test/marketplace.json",
        reference: "https://example.test/marketplace.json",
        local: false,
      })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
''',
)

# ---------------------------------------------------------------------------
# CAS reads file: URLs and materializes local/remote plugins, skills, and
# instructions into the immutable tree.
# ---------------------------------------------------------------------------
replace(
    "packages/opencode/src/marketplace/cache.ts",
    'import { createHash, randomUUID } from "crypto"',
    'import { createHash, randomUUID } from "crypto"\nimport { fileURLToPath, pathToFileURL } from "url"',
)
replace(
    "packages/opencode/src/marketplace/cache.ts",
    '''  MarketplaceInstallPlan,
  MarketplaceSource,
  MarketplaceSkill,
} from "@opencode-ai/core/marketplace"''',
    '''  MarketplaceInstallPlan,
  MarketplacePluginSpec,
  MarketplaceSource,
  MarketplaceSkill,
} from "@opencode-ai/core/marketplace"''',
)
replace(
    "packages/opencode/src/marketplace/cache.ts",
    '''function sameOriginHeaders(source: MarketplaceSource, target: string) {
  if (!source.headers) return undefined
  try {
    const left = new URL(source.url)
    const right = new URL(target)
    return left.origin === right.origin ? source.headers : undefined
  } catch {
    return undefined
  }
}
''',
    '''function sameOriginHeaders(source: MarketplaceSource, target: string) {
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
''',
)

replace(
    "packages/opencode/src/marketplace/cache.ts",
    '''      const url = new URL(input.url).href
      const key = requestKey(url, input.headers)''',
    '''      const parsed = new URL(input.url)
      const url = parsed.href
      const key = requestKey(url, input.headers)''',
)

insert_before(
    "packages/opencode/src/marketplace/cache.ts",
    '''      const headers = new Headers(input.headers)
      if (row?.etag) headers.set("if-none-match", row.etag)''',
    '''      if (parsed.protocol === "file:") {
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

''',
)

replace(
    "packages/opencode/src/marketplace/cache.ts",
    '''      const legacyRoots: string[] = []
      const itemRoots = new Map<string, string>()

      for (const [index, url] of (plan.skills?.urls ?? []).entries()) {
        const roots = yield* indexedSkill({
          url,
          source,
          prefix: path.posix.join("skills", `source-${index}`),
          entries,
          digests,
        })
        legacyRoots.push(...roots.map((root) => root.relative))
      }
''',
    '''      const legacyRoots: string[] = []
      const itemRoots = new Map<string, string>()
      const pluginRelatives = new Map<number, string>()

      for (const [index, plugin] of (plan.plugins ?? []).entries()) {
        const spec = Array.isArray(plugin) ? plugin[0] : plugin
        if (!isArtifactURL(spec)) continue
        const artifact = yield* fetchArtifact({
          url: spec,
          headers: sameOriginHeaders(source, spec),
          kind: "plugin-file",
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
''',
)

insert_before(
    "packages/opencode/src/marketplace/cache.ts",
    '''    const directSkill = Effect.fnUntraced(function* (input: {
      item: MarketplaceSkill''',
    '''    const directSkillSource = Effect.fnUntraced(function* (input: {
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
      })
      input.digests.add(artifact.digest)
      const root = path.posix.join(input.prefix, safeSegment(input.name))
      const relative = path.posix.join(root, "SKILL.md")
      input.entries.set(relative, { relative, bytes: artifact.bytes, digest: artifact.digest })
      return [{ name: input.name, relative: root }]
    })

''',
)

replace(
    "packages/opencode/src/marketplace/cache.ts",
    '''      const url = input.item.url!
      const artifact = yield* fetchArtifact({
        url,''',
    '''      const configured = input.item.url!
      const url = configured.endsWith("/") ? new URL("SKILL.md", configured).href : configured
      const artifact = yield* fetchArtifact({
        url,''',
)

replace(
    "packages/opencode/src/marketplace/cache.ts",
    '        if (!/^https?:\\/\\//i.test(instruction)) continue',
    '        if (!isArtifactURL(instruction)) continue',
)

insert_before(
    "packages/opencode/src/marketplace/cache.ts",
    '''      if (plan.skills) {
        const existing = plan.skills.paths ?? []''',
    '''      if (plan.plugins && pluginRelatives.size) {
        plan.plugins = plan.plugins.map((plugin, index) => {
          const relative = pluginRelatives.get(index)
          if (!relative) return plugin
          const spec = pathToFileURL(path.join(target, ...relative.split("/"))).href
          return (Array.isArray(plugin) ? [spec, clone(plugin[1])] : spec) as MarketplacePluginSpec
        })
      }

''',
)

# Cache tests for local source refresh and immutable local component materialization.
replace(
    "packages/opencode/test/marketplace/cache.test.ts",
    'import fs from "fs/promises"',
    'import fs from "fs/promises"\nimport os from "os"\nimport path from "path"\nimport { fileURLToPath, pathToFileURL } from "url"',
)
insert_before(
    "packages/opencode/test/marketplace/cache.test.ts",
    '''  it.effect("materializes a remote skill into an immutable local tree", () =>''',
    '''  it.effect("reads local sources and materializes local plugins, skills, and instructions", () =>
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
            await fs.writeFile(skill, "---\\nname: review\\ndescription: Review changes\\n---\\nReview the current diff.")
            await fs.writeFile(instruction, "Always review the current diff.")
          })

          const cache = yield* MarketplaceCache.Service
          const first = yield* cache.fetchResponse({ url: pathToFileURL(catalog).href, mode: "refresh", kind: "catalog" })
          expect(await first.text()).toBe('{"version":1}')
          yield* Effect.tryPromise(() => fs.writeFile(catalog, '{"version":2}'))
          const cached = yield* cache.fetchResponse({ url: pathToFileURL(catalog).href, kind: "catalog" })
          expect(await cached.text()).toBe('{"version":1}')
          const refreshed = yield* cache.fetchResponse({ url: pathToFileURL(catalog).href, mode: "refresh", kind: "catalog" })
          expect(await refreshed.text()).toBe('{"version":2}')

          const materialized = yield* cache.materializePlan(
            {
              plugins: [pathToFileURL(plugin).href],
              skills: {
                items: [{ id: "review", name: "review", url: pathToFileURL(path.dirname(skill)).href + "/" }],
              },
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
          expect(await fs.readFile(fileURLToPath(pluginSpec as string), "utf8")).toContain("MarketplacePlugin")
          const skillItem = materialized.plan.skills?.items?.[0]
          expect(skillItem?.url).toBeUndefined()
          expect(await fs.readFile(path.join(skillItem!.path!, "SKILL.md"), "utf8")).toContain("Review the current diff")
          const materializedInstruction = materialized.plan.instructions?.[0]
          expect(materializedInstruction?.startsWith("file:")).toBe(false)
          expect(await fs.readFile(materializedInstruction!, "utf8")).toContain("Always review")
          expect(materialized.artifactDigests.length).toBeGreaterThanOrEqual(3)
        }),
      (root) => Effect.tryPromise(() => fs.rm(root, { recursive: true, force: true })),
    ),
  )

''',
)

# ---------------------------------------------------------------------------
# Source use in Marketplace service and CLI.
# ---------------------------------------------------------------------------
replace(
    "packages/opencode/src/marketplace/service.ts",
    'import * as MarketplaceCache from "./cache"',
    'import * as MarketplaceCache from "./cache"\nimport { resolveMarketplaceSourceReference } from "./source"',
)
replace(
    "packages/opencode/src/marketplace/service.ts",
    '''function sourceHeaders(source: MarketplaceSource, target: string) {
  if (!source.headers) return undefined
  try {
    return new URL(source.url).origin === new URL(target).origin ? source.headers : undefined
  } catch {
    return undefined
  }
}''',
    '''function sourceHeaders(source: MarketplaceSource, target: string) {
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
}''',
)
replace(
    "packages/opencode/src/marketplace/service.ts",
    '        if (!/^https?:\\/\\//i.test(icon)) continue',
    '        if (!/^(?:https?|file):/i.test(icon)) continue',
)
replace(
    "packages/opencode/src/marketplace/service.ts",
    '''      const source = createMarketplaceSource({
        url: input.url,
        name: input.name,
        trust: input.trust,
        headers: input.headers,
      })''',
    '''      const resolved = yield* Effect.promise(() => resolveMarketplaceSourceReference(input.url))
      const source = {
        ...createMarketplaceSource({
          url: resolved.url,
          name: input.name ?? resolved.name,
          trust: input.trust,
          headers: resolved.local ? undefined : input.headers,
        }),
        reference: resolved.reference,
      }''',
)

replace(
    "packages/opencode/src/cli/cmd/plug.ts",
    'import * as MarketplaceRegistry from "@/marketplace/registry"',
    'import * as MarketplaceRegistry from "@/marketplace/registry"\nimport { resolveMarketplaceSourceReference } from "@/marketplace/source"',
)
replace(
    "packages/opencode/src/cli/cmd/plug.ts",
    '''    const source = createMarketplaceSource({
      url: String(args.url),
      name: args.name ? String(args.name) : undefined,
      trust: args.trust as MarketplaceConfiguredTrust,
    })''',
    '''    const resolved = yield* Effect.promise(() => resolveMarketplaceSourceReference(String(args.url)))
    const source = {
      ...createMarketplaceSource({
        url: resolved.url,
        name: args.name ? String(args.name) : resolved.name,
        trust: args.trust as MarketplaceConfiguredTrust,
      }),
      reference: resolved.reference,
    }''',
)

# ---------------------------------------------------------------------------
# Runtime activation barrier: no successful mutation response until all cached
# instance services have been disposed and will rebuild from the new registry.
# ---------------------------------------------------------------------------
replace(
    "packages/opencode/src/server/routes/instance/httpapi/handlers/marketplace.ts",
    'import { EffectBridge } from "@/effect/bridge"\n',
    '',
)
replace(
    "packages/opencode/src/server/routes/instance/httpapi/handlers/marketplace.ts",
    '''    const marketplace = yield* MarketplaceService
    const bridge = yield* EffectBridge.make()

    const runtime = <T extends { ok: boolean; changed?: boolean }>(result: T) => {
      if (result.ok && result.changed) {
        bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      }
      return result
    }''',
    '''    const marketplace = yield* MarketplaceService

    const runtime = <T extends { ok: boolean; changed?: boolean }>(result: T) =>
      result.ok && result.changed
        ? disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }).pipe(Effect.as(result))
        : Effect.succeed(result)''',
)
replace(
    "packages/opencode/src/server/routes/instance/httpapi/handlers/marketplace.ts",
    '.pipe(Effect.map(runtime))',
    '.pipe(Effect.flatMap(runtime))',
    count=4,
)

write(
    "packages/opencode/test/server/httpapi-marketplace-runtime.test.ts",
    '''import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option, Ref } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { MarketplaceMutationResult } from "@opencode-ai/core/marketplace"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Service as MarketplaceService } from "../../src/marketplace/service"
import { Installation } from "../../src/installation"
import { InstanceStore } from "../../src/project/instance-store"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { MarketplacePaths } from "../../src/server/routes/instance/httpapi/groups/marketplace"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { marketplaceHandlers } from "../../src/server/routes/instance/httpapi/handlers/marketplace"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

const disposed = Ref.makeUnsafe(false)
const mutation: MarketplaceMutationResult = {
  ok: true,
  changed: true,
  view: {
    state: { revision: 1 },
    listings: [],
    errors: [],
    cache: { root: "/tmp", objects: 0, total_bytes: 0, fetch_entries: 0, materializations: 0 },
  },
  connect_mcp: [],
  preserved: [],
}

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers, marketplaceHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(
    Layer.mock(MarketplaceService)({
      install: () => Effect.succeed(mutation),
    }),
  ),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(Layer.mock(Installation.Service)({})),
  Layer.provide(
    Layer.mock(InstanceStore.Service)({
      disposeAll: () => Effect.sleep("100 millis").pipe(Effect.andThen(Ref.set(disposed, true))),
    }),
  ),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)
const it = testEffect(apiLayer)

describe("marketplace runtime activation", () => {
  it.live("waits for instance disposal before acknowledging a changed install", () =>
    Effect.gen(function* () {
      yield* Ref.set(disposed, false)
      const response = yield* HttpClientRequest.post(MarketplacePaths.install).pipe(
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({ key: "source:catalog:item", expected_revision: 0, accept_untrusted: true }),
        ),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* Ref.get(disposed)).toBe(true)
      expect((yield* response.json) as { ok: boolean }).toEqual(expect.objectContaining({ ok: true }))
    }),
  )
})
''',
)

write(
    "packages/opencode/test/marketplace/runtime.test.ts",
    '''import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Config } from "@/config/config"
import { Skill } from "@/skill"
import * as MarketplaceRegistry from "@/marketplace/registry"
import { InstanceStore } from "@/project/instance-store"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const layer = Layer.mergeAll(
  LayerNode.compile(LayerNode.group([Config.node, Skill.node, MarketplaceRegistry.node])),
  LayerNode.compile(CrossSpawnSpawner.node),
  testInstanceStoreLayer,
)
const it = testEffect(layer)

it.live("rebuilds every marketplace runtime projection after the instance is disposed", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const registry = yield* MarketplaceRegistry.Service
        const config = yield* Config.Service
        const skill = yield* Skill.Service
        const instances = yield* InstanceStore.Service
        const before = yield* registry.read()
        const skillRoot = path.join(dir, "marketplace-skill")
        const instruction = path.join(dir, "marketplace-instruction.md")
        const plugin = path.join(dir, "marketplace-plugin.ts")
        yield* Effect.tryPromise(async () => {
          await fs.mkdir(skillRoot, { recursive: true })
          await fs.writeFile(
            path.join(skillRoot, "SKILL.md"),
            "---\\nname: marketplace-review\\ndescription: Review through Marketplace\\n---\\nReview the diff.",
          )
          await fs.writeFile(instruction, "Marketplace instruction")
          await fs.writeFile(plugin, "export default async () => ({})")
        })

        expect((yield* skill.all()).some((item) => item.name === "marketplace-review")).toBe(false)
        const plan = {
          plugins: [pathToFileURL(plugin).href],
          skills: { paths: [skillRoot] },
          agents: { marketplace_agent: { description: "Marketplace agent", mode: "subagent" } },
          commands: { marketplace_command: { template: "Run marketplace command" } },
          mcp: { marketplace_docs: { type: "remote", url: "https://example.test/mcp", enabled: false } },
          instructions: [instruction],
        }
        const stored = yield* registry.replace({
          ...before,
          installed: {
            ...(before.installed ?? {}),
            "source:catalog:bundle": {
              source: "source",
              catalog: "catalog",
              item: "bundle",
              name: "Bundle",
              kind: "bundle",
              version: "1.0.0",
              fingerprint: "bundle-v1",
              installed_at: "2026-07-30T00:00:00.000Z",
              updated_at: "2026-07-30T00:00:00.000Z",
              plan,
              active_plan: plan,
              receipt: {},
              enabled: true,
            },
          },
        })
        yield* config.invalidate()
        yield* instances.disposeDirectory(dir)

        const effective = yield* config.get()
        expect(effective.marketplace?.revision).toBe(stored.state.revision)
        expect(effective.plugin).toContain(pathToFileURL(plugin).href)
        expect(effective.plugin_origins?.map((item) => item.spec)).toContain(pathToFileURL(plugin).href)
        expect(effective.agent?.marketplace_agent).toEqual(
          expect.objectContaining({ description: "Marketplace agent", mode: "subagent" }),
        )
        expect(effective.command?.marketplace_command).toEqual({ template: "Run marketplace command" })
        expect(effective.mcp?.marketplace_docs).toEqual(
          expect.objectContaining({ type: "remote", url: "https://example.test/mcp", enabled: false }),
        )
        expect(effective.instructions).toContain(instruction)
        expect((yield* skill.all()).map((item) => item.name)).toContain("marketplace-review")

        const current = yield* registry.read()
        yield* registry.replace({ ...before, revision: current.revision }).pipe(Effect.orDie)
        yield* config.invalidate()
        yield* instances.disposeDirectory(dir)
      }),
    { git: true },
  ),
)
''',
)

# ---------------------------------------------------------------------------
# User-facing source hints and API metadata.
# ---------------------------------------------------------------------------
replace(
    "packages/app/src/components/marketplace-dialog.tsx",
    'placeholder="https://… or github:owner/repository"\n          aria-label="Marketplace source URL"',
    'placeholder="HTTPS, github:owner/repository, or local path"\n          aria-label="Marketplace source URL or local path"',
)
replace(
    "packages/tui/src/feature-plugins/system/marketplace.tsx",
    'const raw = await prompt(props.api, "Add marketplace catalog", "URL or github:owner/repository")',
    'const raw = await prompt(props.api, "Add marketplace catalog", "URL, file URL, or local path")',
)
replace(
    "packages/opencode/src/server/routes/instance/httpapi/groups/marketplace.ts",
    'description: "Add or replace a Marketplace catalog source."',
    'description: "Add or replace an HTTPS, Git repository, file URL, or local filesystem Marketplace source."',
)

# ---------------------------------------------------------------------------
# Documentation: local files on Linux/macOS/Windows and relative local assets.
# ---------------------------------------------------------------------------
replace(
    "packages/web/src/content/docs/marketplace.mdx",
    '''A source may be:

- an HTTPS URL to a Marketplace JSON file;
- a GitHub repository URL;
- `github:owner/repository`;
- an HTTP loopback URL for local development.

For Git repository URLs ending in `.git`, OpenCode looks for `.opencode/marketplace.json` through conventional GitHub,
GitLab, and Gitea raw-file routes. Use `--name` to set a display name and `--trust private` for a private catalog.
''',
    '''A source may be:

- an HTTPS URL to a Marketplace JSON file;
- a GitHub repository URL;
- `github:owner/repository`;
- an HTTP loopback URL for local development;
- a local catalog file, local catalog directory, or `file://` URL.

For Git repository URLs ending in `.git`, OpenCode looks for `.opencode/marketplace.json` through conventional GitHub,
GitLab, and Gitea raw-file routes. For a local directory, OpenCode tries `.opencode/marketplace.json` and then
`marketplace.json`. Use `--name` to set a display name and `--trust private` for a private catalog.

### Local filesystem catalogs

Use an absolute path in the desktop app. The CLI also accepts relative paths and resolves them from the current working
directory.

```bash title="Linux or macOS"
opencode plugin marketplace add ~/opencode-marketplaces/team --trust private
opencode plugin marketplace add /opt/opencode/catalogs/team/marketplace.json --trust private
```

```powershell title="Windows PowerShell"
opencode plugin marketplace add 'C:\\Users\\Alice\\opencode-marketplaces\\team' --trust private
opencode plugin marketplace add '\\\\fileserver\\ai\\team-marketplace' --trust private
```

Equivalent file URLs are supported on every platform, for example `file:///Users/alice/catalogs/team/marketplace.json` or
`file:///C:/Users/Alice/catalogs/team/marketplace.json`. OpenCode stores the canonical file URL in SQLite while retaining
the entered path as the display/export reference.

A local catalog can keep assets beside the catalog and reference them with safe `./` paths. Relative plugin files,
skill paths or URLs, instructions, and icons are resolved from the catalog directory. Plugins, skills, and instructions
are copied into the content-addressed immutable cache before activation, so an installed package remains usable if the
source directory later becomes unavailable. `..` traversal is rejected.

```json title="team/marketplace.json"
{
  "schema": "opencode.marketplace/v1",
  "id": "team-local",
  "name": "Team Local Marketplace",
  "items": [
    {
      "id": "review",
      "name": "Review",
      "description": "Local review plugin and skill",
      "kind": "bundle",
      "version": "1.0.0",
      "install": {
        "plugins": ["./plugins/review.ts"],
        "skills": {
          "items": [{ "id": "review", "name": "review", "path": "./skills/review" }]
        },
        "instructions": ["./instructions/review.md"]
      }
    }
  ]
}
```

Local source paths are machine-specific. A profile that contains them is reproducible only on machines where the same
path or file URL exists.
''',
)
replace(
    "packages/web/src/content/docs/marketplace.mdx",
    '''2. **Materialize** downloads remote skills and instructions, validates their structure, and creates immutable local
   artifacts.''',
    '''2. **Materialize** reads local or downloads remote plugin files, skills, and instructions, validates their structure,
   and creates immutable local artifacts.''',
)
replace(
    "packages/web/src/content/docs/marketplace.mdx",
    '''Marketplace stores catalog responses, item manifests, icons, remote skill files, and remote instruction files by their
SHA-256 digest in the OpenCode cache directory.''',
    '''Marketplace stores local and remote catalog responses, item manifests, icons, plugin files, skill files, and instruction
files by their SHA-256 digest in the OpenCode cache directory.''',
)
replace(
    "packages/web/src/content/docs/marketplace.mdx",
    '''Remote skill and instruction content is materialized into immutable local trees before activation.''',
    '''Local or remote plugin, skill, and instruction content is materialized into immutable local trees before activation.''',
)
replace(
    "packages/web/src/content/docs/marketplace.mdx",
    '"path": "./skills/review"',
    '"url": "./skills/review/"',
)
replace(
    "packages/web/src/content/docs/marketplace.mdx",
    '"path": "./skills/release-notes"',
    '"url": "./skills/release-notes/"',
)
replace(
    "packages/web/src/content/docs/marketplace.mdx",
    '''Declare named skills under `install.skills.items`. Each item requires an `id` and the actual skill `name`, and may point
to a dedicated `path` or `url`. Multiple skills may share a source.''',
    '''Declare named skills under `install.skills.items`. Each item requires an `id` and the actual skill `name`, and may point
to a dedicated `path` or `url`. A catalog-relative `path` is treated as a skill directory and materialized; a relative
`url` may target either a directory ending in `/` or a `SKILL.md` file. Multiple skills may share a source.''',
)

replace(
    "packages/web/src/content/docs/ru/marketplace.mdx",
    '''Источником может быть:

- HTTPS URL JSON-файла Marketplace;
- URL репозитория GitHub;
- сокращение `github:owner/repository`;
- loopback HTTP URL для локальной разработки.

Для URL Git-репозитория с окончанием `.git` OpenCode ищет `.opencode/marketplace.json` через стандартные маршруты сырых
файлов GitHub, GitLab и Gitea. Параметр `--name` задаёт отображаемое имя, а `--trust private` — приватный каталог.
''',
    '''Источником может быть:

- HTTPS URL JSON-файла Marketplace;
- URL репозитория GitHub;
- сокращение `github:owner/repository`;
- loopback HTTP URL для локальной разработки;
- локальный файл каталога, локальный каталог или `file://` URL.

Для URL Git-репозитория с окончанием `.git` OpenCode ищет `.opencode/marketplace.json` через стандартные маршруты сырых
файлов GitHub, GitLab и Gitea. Для локального каталога OpenCode сначала проверяет `.opencode/marketplace.json`, затем
`marketplace.json`. Параметр `--name` задаёт отображаемое имя, а `--trust private` — приватный каталог.

### Каталоги в локальной файловой системе

В десктопном приложении используйте абсолютный путь. CLI также принимает относительные пути и разрешает их относительно
текущего рабочего каталога.

```bash title="Linux или macOS"
opencode plugin marketplace add ~/opencode-marketplaces/team --trust private
opencode plugin marketplace add /opt/opencode/catalogs/team/marketplace.json --trust private
```

```powershell title="Windows PowerShell"
opencode plugin marketplace add 'C:\\Users\\Alice\\opencode-marketplaces\\team' --trust private
opencode plugin marketplace add '\\\\fileserver\\ai\\team-marketplace' --trust private
```

На всех платформах поддерживаются эквивалентные file URL, например
`file:///Users/alice/catalogs/team/marketplace.json` и `file:///C:/Users/Alice/catalogs/team/marketplace.json`. В SQLite
OpenCode хранит канонический file URL, а введённый путь сохраняет как отображаемую и экспортируемую ссылку.

Локальный каталог может хранить ресурсы рядом с файлом каталога и ссылаться на них безопасными путями с `./`.
Относительные файлы плагинов, пути или URL скилов, инструкции и иконки разрешаются относительно каталога. Плагины,
скилы и инструкции копируются в неизменяемый content-addressed кэш до активации, поэтому установленный пакет продолжает
работать, даже если исходный каталог позже недоступен. Переход через `..` запрещён.

```json title="team/marketplace.json"
{
  "schema": "opencode.marketplace/v1",
  "id": "team-local",
  "name": "Team Local Marketplace",
  "items": [
    {
      "id": "review",
      "name": "Review",
      "description": "Локальный плагин и скил для ревью",
      "kind": "bundle",
      "version": "1.0.0",
      "install": {
        "plugins": ["./plugins/review.ts"],
        "skills": {
          "items": [{ "id": "review", "name": "review", "path": "./skills/review" }]
        },
        "instructions": ["./instructions/review.md"]
      }
    }
  ]
}
```

Пути локальных источников зависят от машины. Профиль с такими источниками воспроизводим только там, где существует тот
же путь или file URL.
''',
)
replace(
    "packages/web/src/content/docs/ru/marketplace.mdx",
    '''2. **Материализация** загружает удалённые скилы и инструкции, проверяет их структуру и создаёт неизменяемые локальные
   артефакты.''',
    '''2. **Материализация** читает локальные или загружает удалённые файлы плагинов, скилы и инструкции, проверяет их
   структуру и создаёт неизменяемые локальные артефакты.''',
)
replace(
    "packages/web/src/content/docs/ru/marketplace.mdx",
    '''Marketplace сохраняет ответы каталогов, манифесты элементов, иконки, удалённые файлы скилов и инструкции по их SHA-256
digest в каталоге кэша OpenCode.''',
    '''Marketplace сохраняет локальные и удалённые ответы каталогов, манифесты элементов, иконки, файлы плагинов, скилов и
инструкций по их SHA-256 digest в каталоге кэша OpenCode.''',
)
replace(
    "packages/web/src/content/docs/ru/marketplace.mdx",
    '''Удалённые скилы и инструкции материализуются в неизменяемые локальные деревья до активации.''',
    '''Локальные и удалённые плагины, скилы и инструкции материализуются в неизменяемые локальные деревья до активации.''',
)
replace(
    "packages/web/src/content/docs/ru/marketplace.mdx",
    '"path": "./skills/review"',
    '"url": "./skills/review/"',
)
replace(
    "packages/web/src/content/docs/ru/marketplace.mdx",
    '"path": "./skills/release-notes"',
    '"url": "./skills/release-notes/"',
)

print("Marketplace runtime activation and local-source changes applied")
