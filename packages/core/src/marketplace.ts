import npa from "npm-package-arg"
import semver from "semver"

export type MarketplaceKind = "plugin" | "skill" | "agent" | "command" | "mcp" | "bundle"
export type MarketplaceTrust = "official" | "verified" | "community" | "private"
export type MarketplaceStatus = "available" | "installed" | "update"
export type MarketplaceFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type MarketplaceSource = {
  id: string
  name: string
  url: string
  enabled?: boolean
  trust?: MarketplaceTrust
  headers?: Record<string, string>
}

export type MarketplacePublisher = {
  name: string
  url?: string
  verified?: boolean
}

export type MarketplacePluginSpec = string | [string, Record<string, unknown>]

export type MarketplaceInstallPlan = {
  plugins?: MarketplacePluginSpec[]
  skills?: {
    paths?: string[]
    urls?: string[]
  }
  agents?: Record<string, Record<string, unknown>>
  commands?: Record<string, Record<string, unknown>>
  mcp?: Record<string, Record<string, unknown>>
  instructions?: string[]
}

export type MarketplaceCatalogItem = {
  id: string
  name: string
  description: string
  kind: MarketplaceKind
  version: string
  publisher?: MarketplacePublisher
  homepage?: string
  repository?: string
  license?: string
  tags?: string[]
  featured?: boolean
  compatibility?: {
    opencode?: string
    platforms?: string[]
  }
  permissions?: string[]
  setup?: string[]
  requires_restart?: boolean
  install: MarketplaceInstallPlan
}

export type MarketplaceCatalog = {
  schema: "opencode.marketplace/v1"
  id: string
  name: string
  description?: string
  publisher?: MarketplacePublisher
  homepage?: string
  updated_at?: string
  items: MarketplaceCatalogItem[]
}

export type MarketplaceRestoreValue = {
  existed: boolean
  value?: unknown
}

export type MarketplacePluginRestore = {
  identity: string
  previous: MarketplacePluginSpec[]
}

export type MarketplaceReceipt = {
  plugins?: MarketplacePluginRestore[]
  skills?: {
    paths?: Record<string, boolean>
    urls?: Record<string, boolean>
  }
  agents?: Record<string, MarketplaceRestoreValue>
  commands?: Record<string, MarketplaceRestoreValue>
  mcp?: Record<string, MarketplaceRestoreValue>
  instructions?: Record<string, boolean>
}

export type MarketplaceInstalled = {
  source: string
  source_url?: string
  catalog: string
  catalog_name?: string
  item: string
  name: string
  kind: MarketplaceKind
  version: string
  publisher?: string
  fingerprint: string
  installed_at: string
  updated_at: string
  plan: MarketplaceInstallPlan
  receipt: MarketplaceReceipt
}

export type MarketplaceState = {
  sources?: MarketplaceSource[]
  installed?: Record<string, MarketplaceInstalled>
}

export type MarketplaceHostConfig = {
  plugin?: MarketplacePluginSpec[]
  skills?: {
    paths?: string[]
    urls?: string[]
    [key: string]: unknown
  }
  agent?: Record<string, unknown>
  command?: Record<string, unknown>
  mcp?: Record<string, unknown>
  instructions?: string[]
  marketplace?: MarketplaceState
  [key: string]: unknown
}

export type MarketplaceListing = {
  key: string
  source: MarketplaceSource
  catalog: MarketplaceCatalog
  item: MarketplaceCatalogItem
}

export type MarketplaceLoadError = {
  source: MarketplaceSource
  message: string
}

export type MarketplaceLoadResult = {
  listings: MarketplaceListing[]
  errors: MarketplaceLoadError[]
}

export type MarketplaceConflict = {
  path: string
  current: unknown
  incoming: unknown
}

export type MarketplaceInstallResult =
  | {
      ok: true
      config: MarketplaceHostConfig
      conflicts: []
    }
  | {
      ok: false
      conflicts: MarketplaceConflict[]
    }

export type MarketplaceUninstallResult = {
  config: MarketplaceHostConfig
  preserved: string[]
}

export const OFFICIAL_MARKETPLACE_SOURCE: MarketplaceSource = {
  id: "opencode",
  name: "OpenCode",
  url: "builtin://opencode",
  enabled: true,
  trust: "official",
}

const OFFICIAL_MARKETPLACE_CATALOG: MarketplaceCatalog = {
  schema: "opencode.marketplace/v1",
  id: "opencode",
  name: "OpenCode Marketplace",
  description: "The built-in OpenCode catalog. Additional catalogs can be added from the Sources tab.",
  publisher: {
    name: "OpenCode",
    url: "https://opencode.ai",
    verified: true,
  },
  items: [],
}

const KINDS = new Set<MarketplaceKind>(["plugin", "skill", "agent", "command", "mcp", "bundle"])
const TRUST = new Set<MarketplaceTrust>(["official", "verified", "community", "private"])

export function marketplaceSources(config: MarketplaceHostConfig) {
  const sources = new Map<string, MarketplaceSource>([[OFFICIAL_MARKETPLACE_SOURCE.id, OFFICIAL_MARKETPLACE_SOURCE]])
  for (const source of config.marketplace?.sources ?? []) sources.set(source.id, source)
  return Array.from(sources.values())
}

export function createMarketplaceSource(input: {
  url: string
  name?: string
  trust?: MarketplaceTrust
  headers?: Record<string, string>
}) {
  const url = normalizeMarketplaceURL(input.url)
  const host = sourceHost(url)
  return {
    id: `source-${hash(url)}`,
    name: input.name?.trim() || host || "Marketplace catalog",
    url,
    enabled: true,
    trust: input.trust ?? "community",
    ...(input.headers ? { headers: input.headers } : {}),
  } satisfies MarketplaceSource
}

export function upsertMarketplaceSource(config: MarketplaceHostConfig, source: MarketplaceSource) {
  const next = clone(config)
  const sources = next.marketplace?.sources ?? []
  next.marketplace = {
    ...next.marketplace,
    sources: [...sources.filter((item) => item.id !== source.id), source],
  }
  return next
}

export function toggleMarketplaceSource(config: MarketplaceHostConfig, id: string, enabled: boolean) {
  const source = marketplaceSources(config).find((item) => item.id === id)
  if (!source) return clone(config)
  return upsertMarketplaceSource(config, { ...source, enabled })
}

export function removeMarketplaceSource(config: MarketplaceHostConfig, id: string) {
  const next = clone(config)
  next.marketplace = {
    ...next.marketplace,
    sources: (next.marketplace?.sources ?? []).filter((source) => source.id !== id),
  }
  return next
}

export async function loadMarketplace(input: {
  config: MarketplaceHostConfig
  fetch?: MarketplaceFetch
  timeout?: number
}): Promise<MarketplaceLoadResult> {
  const fetcher = input.fetch ?? globalThis.fetch
  const rows = await Promise.all(
    marketplaceSources(input.config)
      .filter((source) => source.enabled !== false)
      .map(async (source) => {
        try {
          const catalog =
            source.url === OFFICIAL_MARKETPLACE_SOURCE.url
              ? OFFICIAL_MARKETPLACE_CATALOG
              : parseMarketplaceCatalog(
                  await fetcher(normalizeMarketplaceURL(source.url), {
                    headers: source.headers,
                    cache: "no-store",
                    signal: AbortSignal.timeout(input.timeout ?? 10_000),
                  }).then(async (response) => {
                    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
                    return response.json()
                  }),
                )
          return { ok: true as const, source, catalog }
        } catch (error) {
          return { ok: false as const, source, error: error instanceof Error ? error.message : String(error) }
        }
      }),
  )

  const listings: MarketplaceListing[] = rows.flatMap((row) => {
    if (!row.ok) return []
    return row.catalog.items.map((item) => ({
      key: marketplaceKey(row.source.id, row.catalog.id, item.id),
      source: row.source,
      catalog: row.catalog,
      item,
    }))
  })

  return {
    listings: listings.toSorted((a, b) => {
      if (a.item.featured !== b.item.featured) return a.item.featured ? -1 : 1
      const name = a.item.name.localeCompare(b.item.name)
      if (name !== 0) return name
      return a.key.localeCompare(b.key)
    }),
    errors: rows.flatMap((row) => (row.ok ? [] : [{ source: row.source, message: row.error }])),
  }
}

export function parseMarketplaceCatalog(value: unknown): MarketplaceCatalog {
  const catalog = record(value, "catalog")
  if (catalog.schema !== "opencode.marketplace/v1") {
    throw new Error("Unsupported marketplace schema; expected opencode.marketplace/v1")
  }
  const items = array(catalog.items, "catalog.items").map((item, index) => parseItem(item, index))
  const ids = new Set<string>()
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`Duplicate marketplace item id: ${item.id}`)
    ids.add(item.id)
  }
  return {
    schema: catalog.schema,
    id: text(catalog.id, "catalog.id"),
    name: text(catalog.name, "catalog.name"),
    ...(optionalText(catalog.description, "catalog.description") ? { description: catalog.description as string } : {}),
    ...(catalog.publisher === undefined ? {} : { publisher: parsePublisher(catalog.publisher, "catalog.publisher") }),
    ...(optionalText(catalog.homepage, "catalog.homepage") ? { homepage: catalog.homepage as string } : {}),
    ...(optionalText(catalog.updated_at, "catalog.updated_at") ? { updated_at: catalog.updated_at as string } : {}),
    items,
  }
}

export function marketplaceStatus(config: MarketplaceHostConfig, listing: MarketplaceListing): MarketplaceStatus {
  const installed = config.marketplace?.installed?.[listing.key]
  if (!installed) return "available"
  if (installed.fingerprint !== fingerprint(listing.item)) return "update"
  if (semver.valid(installed.version) && semver.valid(listing.item.version)) {
    return semver.gt(listing.item.version, installed.version) ? "update" : "installed"
  }
  return installed.version === listing.item.version ? "installed" : "update"
}

export function installMarketplaceItem(
  config: MarketplaceHostConfig,
  listing: MarketplaceListing,
  options?: { force?: boolean },
): MarketplaceInstallResult {
  const current = config.marketplace?.installed?.[listing.key]
  const base = current ? uninstallMarketplaceItem(config, listing.key).config : clone(config)
  const conflicts = marketplaceConflicts(base, listing.item.install)
  if (conflicts.length > 0 && options?.force !== true) return { ok: false, conflicts }

  const receipt = applyPlan(base, listing.item.install)
  const now = new Date().toISOString()
  base.marketplace = {
    ...base.marketplace,
    installed: {
      ...base.marketplace?.installed,
      [listing.key]: {
        source: listing.source.id,
        source_url: listing.source.url,
        catalog: listing.catalog.id,
        catalog_name: listing.catalog.name,
        item: listing.item.id,
        name: listing.item.name,
        kind: listing.item.kind,
        version: listing.item.version,
        publisher: listing.item.publisher?.name ?? listing.catalog.publisher?.name,
        fingerprint: fingerprint(listing.item),
        installed_at: current?.installed_at ?? now,
        updated_at: now,
        plan: clone(listing.item.install),
        receipt,
      },
    },
  }
  return { ok: true, config: base, conflicts: [] }
}

export function uninstallMarketplaceItem(config: MarketplaceHostConfig, key: string): MarketplaceUninstallResult {
  const installed = config.marketplace?.installed?.[key]
  if (!installed) return { config: clone(config), preserved: [] }
  const next = clone(config)
  const preserved: string[] = []
  restorePlugins(next, installed, preserved)
  restoreArray(next, "skills.paths", installed.plan.skills?.paths, installed.receipt.skills?.paths, preserved)
  restoreArray(next, "skills.urls", installed.plan.skills?.urls, installed.receipt.skills?.urls, preserved)
  restoreObject(next, "agent", installed.plan.agents, installed.receipt.agents, preserved)
  restoreObject(next, "command", installed.plan.commands, installed.receipt.commands, preserved)
  restoreObject(next, "mcp", installed.plan.mcp, installed.receipt.mcp, preserved)
  restoreArray(next, "instructions", installed.plan.instructions, installed.receipt.instructions, preserved)
  const entries = { ...next.marketplace?.installed }
  delete entries[key]
  next.marketplace = { ...next.marketplace, installed: entries }
  return { config: next, preserved }
}

export function marketplaceConflicts(config: MarketplaceHostConfig, plan: MarketplaceInstallPlan) {
  const conflicts: MarketplaceConflict[] = []
  for (const plugin of plan.plugins ?? []) {
    const current = (config.plugin ?? []).filter((item) => pluginIdentity(item) === pluginIdentity(plugin))
    if (current.length > 0 && !equal(current, [plugin])) {
      conflicts.push({ path: `plugin.${pluginIdentity(plugin)}`, current, incoming: plugin })
    }
  }
  collectObjectConflicts(conflicts, "agent", config.agent, plan.agents)
  collectObjectConflicts(conflicts, "command", config.command, plan.commands)
  collectObjectConflicts(conflicts, "mcp", config.mcp, plan.mcp)
  return conflicts
}

export function marketplacePermissions(item: MarketplaceCatalogItem) {
  const permissions = new Set(item.permissions ?? [])
  if (item.install.plugins?.length) permissions.add("Runs third-party plugin code inside OpenCode")
  if (item.install.skills?.paths?.length || item.install.skills?.urls?.length) {
    permissions.add("Adds instructions that agents can load on demand")
  }
  if (Object.keys(item.install.agents ?? {}).length) permissions.add("Adds or replaces agent configuration")
  if (Object.keys(item.install.commands ?? {}).length) permissions.add("Adds slash commands")
  if (Object.keys(item.install.mcp ?? {}).length) permissions.add("Starts or connects to MCP servers")
  if (item.install.instructions?.length) permissions.add("Adds persistent project instructions")
  return Array.from(permissions)
}

export function marketplacePlanSummary(plan: MarketplaceInstallPlan) {
  return (
    [
      plan.plugins?.length ? `${plan.plugins.length} plugin${plan.plugins.length === 1 ? "" : "s"}` : undefined,
      (plan.skills?.paths?.length ?? 0) + (plan.skills?.urls?.length ?? 0)
        ? `${(plan.skills?.paths?.length ?? 0) + (plan.skills?.urls?.length ?? 0)} skill source${(plan.skills?.paths?.length ?? 0) + (plan.skills?.urls?.length ?? 0) === 1 ? "" : "s"}`
        : undefined,
      Object.keys(plan.agents ?? {}).length
        ? `${Object.keys(plan.agents ?? {}).length} agent${Object.keys(plan.agents ?? {}).length === 1 ? "" : "s"}`
        : undefined,
      Object.keys(plan.commands ?? {}).length
        ? `${Object.keys(plan.commands ?? {}).length} command${Object.keys(plan.commands ?? {}).length === 1 ? "" : "s"}`
        : undefined,
      Object.keys(plan.mcp ?? {}).length
        ? `${Object.keys(plan.mcp ?? {}).length} MCP server${Object.keys(plan.mcp ?? {}).length === 1 ? "" : "s"}`
        : undefined,
      plan.instructions?.length
        ? `${plan.instructions.length} instruction file${plan.instructions.length === 1 ? "" : "s"}`
        : undefined,
    ]
      .filter((item): item is string => item !== undefined)
      .join(", ") || "No configuration changes"
  )
}

export function normalizeMarketplaceURL(value: string) {
  const url = value.trim()
  if (!url) throw new Error("Marketplace catalog URL is required")
  if (url.startsWith("builtin://")) return url
  if (url.startsWith("github:")) {
    const repo = url.slice("github:".length).replace(/^\/+/, "")
    const [owner, name, ...parts] = repo.split("/")
    if (!owner || !name) throw new Error("GitHub marketplace source must use github:owner/repository")
    return `https://raw.githubusercontent.com/${owner}/${name}/HEAD/${parts.join("/") || ".opencode/marketplace.json"}`
  }
  const parsed = new URL(url)
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Marketplace sources must use HTTPS, HTTP, github:, or builtin:")
  }
  if (parsed.hostname === "github.com") {
    const [owner, repo, action, branch, ...parts] = parsed.pathname.split("/").filter(Boolean)
    if (!owner || !repo) throw new Error("Invalid GitHub marketplace URL")
    if (action === "blob" && branch && parts.length) {
      return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${parts.join("/")}`
    }
    if (!action) return `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/.opencode/marketplace.json`
  }
  return parsed.href
}

function parseItem(value: unknown, index: number): MarketplaceCatalogItem {
  const item = record(value, `catalog.items[${index}]`)
  const kind = text(item.kind, `catalog.items[${index}].kind`)
  if (!KINDS.has(kind as MarketplaceKind)) throw new Error(`Unsupported marketplace kind: ${kind}`)
  return {
    id: text(item.id, `catalog.items[${index}].id`),
    name: text(item.name, `catalog.items[${index}].name`),
    description: text(item.description, `catalog.items[${index}].description`),
    kind: kind as MarketplaceKind,
    version: text(item.version, `catalog.items[${index}].version`),
    ...(item.publisher === undefined
      ? {}
      : { publisher: parsePublisher(item.publisher, `catalog.items[${index}].publisher`) }),
    ...(optionalText(item.homepage, `catalog.items[${index}].homepage`) ? { homepage: item.homepage as string } : {}),
    ...(optionalText(item.repository, `catalog.items[${index}].repository`)
      ? { repository: item.repository as string }
      : {}),
    ...(optionalText(item.license, `catalog.items[${index}].license`) ? { license: item.license as string } : {}),
    ...(item.tags === undefined ? {} : { tags: strings(item.tags, `catalog.items[${index}].tags`) }),
    ...(typeof item.featured === "boolean" ? { featured: item.featured } : {}),
    ...(item.compatibility === undefined
      ? {}
      : { compatibility: parseCompatibility(item.compatibility, `catalog.items[${index}].compatibility`) }),
    ...(item.permissions === undefined
      ? {}
      : { permissions: strings(item.permissions, `catalog.items[${index}].permissions`) }),
    ...(item.setup === undefined ? {} : { setup: strings(item.setup, `catalog.items[${index}].setup`) }),
    ...(typeof item.requires_restart === "boolean" ? { requires_restart: item.requires_restart } : {}),
    install: parsePlan(item.install, `catalog.items[${index}].install`),
  }
}

function parsePublisher(value: unknown, label: string): MarketplacePublisher {
  const publisher = record(value, label)
  return {
    name: text(publisher.name, `${label}.name`),
    ...(optionalText(publisher.url, `${label}.url`) ? { url: publisher.url as string } : {}),
    ...(typeof publisher.verified === "boolean" ? { verified: publisher.verified } : {}),
  }
}

function parseCompatibility(value: unknown, label: string) {
  const compatibility = record(value, label)
  return {
    ...(optionalText(compatibility.opencode, `${label}.opencode`)
      ? { opencode: compatibility.opencode as string }
      : {}),
    ...(compatibility.platforms === undefined
      ? {}
      : { platforms: strings(compatibility.platforms, `${label}.platforms`) }),
  }
}

function parsePlan(value: unknown, label: string): MarketplaceInstallPlan {
  const plan = record(value, label)
  return {
    ...(plan.plugins === undefined ? {} : { plugins: plugins(plan.plugins, `${label}.plugins`) }),
    ...(plan.skills === undefined ? {} : { skills: parseSkills(plan.skills, `${label}.skills`) }),
    ...(plan.agents === undefined ? {} : { agents: objectMap(plan.agents, `${label}.agents`) }),
    ...(plan.commands === undefined ? {} : { commands: objectMap(plan.commands, `${label}.commands`) }),
    ...(plan.mcp === undefined ? {} : { mcp: objectMap(plan.mcp, `${label}.mcp`) }),
    ...(plan.instructions === undefined ? {} : { instructions: strings(plan.instructions, `${label}.instructions`) }),
  }
}

function parseSkills(value: unknown, label: string) {
  const skills = record(value, label)
  return {
    ...(skills.paths === undefined ? {} : { paths: strings(skills.paths, `${label}.paths`) }),
    ...(skills.urls === undefined ? {} : { urls: strings(skills.urls, `${label}.urls`) }),
  }
}

function plugins(value: unknown, label: string): MarketplacePluginSpec[] {
  return array(value, label).map((item, index) => {
    if (typeof item === "string" && item.trim()) return item
    if (Array.isArray(item) && item.length === 2 && typeof item[0] === "string" && isRecord(item[1])) {
      return [item[0], item[1]]
    }
    throw new Error(`${label}[${index}] must be a plugin package string or [package, options] tuple`)
  })
}

function objectMap(value: unknown, label: string) {
  const input = record(value, label)
  return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, record(item, `${label}.${key}`)]))
}

function collectObjectConflicts(
  conflicts: MarketplaceConflict[],
  root: string,
  current: Record<string, unknown> | undefined,
  incoming: Record<string, Record<string, unknown>> | undefined,
) {
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (!(key in (current ?? {}))) continue
    if (equal(current?.[key], value)) continue
    conflicts.push({ path: `${root}.${key}`, current: current?.[key], incoming: value })
  }
}

function applyPlan(config: MarketplaceHostConfig, plan: MarketplaceInstallPlan): MarketplaceReceipt {
  const receipt: MarketplaceReceipt = {}
  if (plan.plugins?.length) {
    receipt.plugins = plan.plugins.map((plugin) => {
      const identity = pluginIdentity(plugin)
      const previous = (config.plugin ?? []).filter((item) => pluginIdentity(item) === identity)
      config.plugin = [...(config.plugin ?? []).filter((item) => pluginIdentity(item) !== identity), clone(plugin)]
      return { identity, previous: clone(previous) }
    })
  }
  if (plan.skills?.paths?.length || plan.skills?.urls?.length) {
    receipt.skills = {}
    if (plan.skills.paths?.length) {
      receipt.skills.paths = addArray(config, "skills.paths", plan.skills.paths)
    }
    if (plan.skills.urls?.length) {
      receipt.skills.urls = addArray(config, "skills.urls", plan.skills.urls)
    }
  }
  if (Object.keys(plan.agents ?? {}).length) receipt.agents = applyObject(config, "agent", plan.agents ?? {})
  if (Object.keys(plan.commands ?? {}).length) receipt.commands = applyObject(config, "command", plan.commands ?? {})
  if (Object.keys(plan.mcp ?? {}).length) receipt.mcp = applyObject(config, "mcp", plan.mcp ?? {})
  if (plan.instructions?.length) receipt.instructions = addArray(config, "instructions", plan.instructions)
  return receipt
}

function addArray(
  config: MarketplaceHostConfig,
  path: "skills.paths" | "skills.urls" | "instructions",
  values: string[],
) {
  const current = readArray(config, path)
  const receipt = Object.fromEntries(values.map((value) => [value, current.includes(value)]))
  writeArray(config, path, Array.from(new Set([...current, ...values])))
  return receipt
}

function applyObject(
  config: MarketplaceHostConfig,
  root: "agent" | "command" | "mcp",
  values: Record<string, Record<string, unknown>>,
) {
  const current = config[root] ?? {}
  const receipt = Object.fromEntries(
    Object.entries(values).map(([key]) => [
      key,
      key in current ? { existed: true, value: clone(current[key]) } : { existed: false },
    ]),
  )
  config[root] = { ...current, ...clone(values) }
  return receipt
}

function restorePlugins(config: MarketplaceHostConfig, installed: MarketplaceInstalled, preserved: string[]) {
  for (const plugin of installed.plan.plugins ?? []) {
    const identity = pluginIdentity(plugin)
    const current = (config.plugin ?? []).filter((item) => pluginIdentity(item) === identity)
    if (!equal(current, [plugin])) {
      preserved.push(`plugin.${identity}`)
      continue
    }
    const previous = installed.receipt.plugins?.find((item) => item.identity === identity)?.previous ?? []
    config.plugin = [...(config.plugin ?? []).filter((item) => pluginIdentity(item) !== identity), ...clone(previous)]
  }
}

function restoreObject(
  config: MarketplaceHostConfig,
  root: "agent" | "command" | "mcp",
  values: Record<string, Record<string, unknown>> | undefined,
  receipt: Record<string, MarketplaceRestoreValue> | undefined,
  preserved: string[],
) {
  if (!values) return
  const current = { ...(config[root] ?? {}) }
  for (const [key, value] of Object.entries(values)) {
    if (!equal(current[key], value)) {
      preserved.push(`${root}.${key}`)
      continue
    }
    const previous = receipt?.[key]
    if (previous?.existed) current[key] = clone(previous.value)
    else delete current[key]
  }
  config[root] = current
}

function restoreArray(
  config: MarketplaceHostConfig,
  path: "skills.paths" | "skills.urls" | "instructions",
  values: string[] | undefined,
  receipt: Record<string, boolean> | undefined,
  preserved: string[],
) {
  if (!values) return
  const current = readArray(config, path)
  const next = current.filter((value) => receipt?.[value] !== false)
  for (const value of values) {
    if (receipt?.[value] === false && !current.includes(value)) preserved.push(`${path}.${value}`)
  }
  writeArray(config, path, next)
}

function readArray(config: MarketplaceHostConfig, path: "skills.paths" | "skills.urls" | "instructions") {
  if (path === "instructions") return config.instructions ?? []
  return config.skills?.[path === "skills.paths" ? "paths" : "urls"] ?? []
}

function writeArray(
  config: MarketplaceHostConfig,
  path: "skills.paths" | "skills.urls" | "instructions",
  values: string[],
) {
  if (path === "instructions") {
    config.instructions = values
    return
  }
  const key = path === "skills.paths" ? "paths" : "urls"
  config.skills = { ...config.skills, [key]: values }
}

function pluginIdentity(plugin: MarketplacePluginSpec) {
  const spec = Array.isArray(plugin) ? plugin[0] : plugin
  try {
    return npa(spec).name ?? spec
  } catch {
    return spec
  }
}

function marketplaceKey(source: string, catalog: string, item: string) {
  return `${source}:${catalog}:${item}`
}

function fingerprint(item: MarketplaceCatalogItem) {
  return hash(stable(item))
}

function sourceHost(value: string) {
  if (value.startsWith("builtin://")) return value.slice("builtin://".length)
  try {
    return new URL(value).hostname
  } catch {
    return ""
  }
}

function hash(value: string) {
  let result = 2166136261
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(36)
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function equal(a: unknown, b: unknown) {
  return stable(a) === stable(b)
}

function clone<Value>(value: Value): Value {
  return structuredClone(value)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  return value
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function strings(value: unknown, label: string) {
  return array(value, label).map((item, index) => text(item, `${label}[${index}]`))
}

function text(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function optionalText(value: unknown, label: string) {
  if (value === undefined) return false
  text(value, label)
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
