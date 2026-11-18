import path from "path"
import { ConfigMarkdown } from "../config/markdown.js"
import type {
  MarketplaceCatalog,
  MarketplaceFetch,
  MarketplaceInstallPlan,
  MarketplaceCatalogItem,
} from "../marketplace.js"

export type ForeignMarketplacePlugin = {
  format: "claude" | "copilot" | "codex"
  catalog_url: string
  entry: Record<string, unknown>
}

/** Group pinned assets for one sparse Git transfer per repository commit. */
export function foreignSkillRepositories(plan: MarketplaceInstallPlan) {
  const repositories = new Map<string, { remote: string; commit: string; files: Map<string, string> }>()
  if (!plan.foreign) return []
  for (const skill of plan.skills?.items ?? []) {
    for (const url of Object.values(skill.files ?? {})) {
      const parsed = new URL(url)
      const [owner, repo, sha, ...parts] = parsed.pathname.slice(1).split("/").map(decodeURIComponent)
      if (parsed.hostname !== "raw.githubusercontent.com" || !owner || !repo || !sha || !/^[a-f\d]{40}$/i.test(sha))
        continue
      const key = `${owner}/${repo}/${sha}`
      const entry = repositories.get(key) ?? {
        remote: `https://github.com/${owner}/${repo}.git`,
        commit: sha,
        files: new Map<string, string>(),
      }
      entry.files.set(url, parts.join("/"))
      repositories.set(key, entry)
    }
  }
  return Array.from(repositories.values())
}

/** Foreign bundles contain declarative components, not OpenCode runtime plugins. */
export function parseForeignMarketplaceCatalog(value: unknown, url: string): MarketplaceCatalog | undefined {
  const format = url.endsWith("/.claude-plugin/marketplace.json")
    ? "claude"
    : url.endsWith("/.github/plugin/marketplace.json")
      ? "copilot"
      : url.endsWith("/.agents/plugins/marketplace.json")
        ? "codex"
        : undefined
  if (!format) return
  const catalog = object(value, "marketplace")
  if (catalog.schema === "opencode.marketplace/v1") return
  if (!Array.isArray(catalog.plugins)) throw new Error("Foreign marketplace must contain a plugins array")
  // Anthropic's community catalog already exceeds 2,000 entries. Keep a
  // bounded count without truncating the catalog (the byte limit still applies).
  if (catalog.plugins.length > 5_000) throw new Error("Marketplace catalog contains too many items; maximum is 5000")
  const name = requiredText(catalog.name, "marketplace.name")
  const owner = catalog.owner === undefined ? undefined : object(catalog.owner, "marketplace.owner")
  const display = catalog.interface === undefined ? undefined : object(catalog.interface, "marketplace.interface")
  const ids = new Set<string>()
  return {
    schema: "opencode.marketplace/v1",
    id: identifier(name),
    name: optionalText(display?.displayName) ?? name,
    ...(optionalText(catalog.description) ? { description: optionalText(catalog.description) } : {}),
    ...(optionalText(owner?.name) ? { publisher: { name: requiredText(owner?.name, "owner.name") } } : {}),
    items: catalog.plugins.map((value) => {
      const entry = object(value, "marketplace plugin")
      const name = requiredText(entry.name, "plugin.name")
      const id = identifier(name)
      if (ids.has(id)) throw new Error(`Duplicate marketplace item id: ${id}`)
      ids.add(id)
      const author = entry.author === undefined ? undefined : object(entry.author, "plugin.author")
      return {
        id,
        name,
        description: optionalText(entry.description) ?? `${name} (${format} plugin bundle)`,
        kind: "bundle",
        version: optionalText(entry.version) ?? "unversioned",
        ...presentation(entry, { format, catalog_url: url, entry }),
        ...(optionalText(author?.name) ? { publisher: { name: requiredText(author?.name, "author.name") } } : {}),
        ...(optionalText(entry.homepage)?.startsWith("https://") ? { homepage: optionalText(entry.homepage) } : {}),
        setup: [
          "Imports compatible skills, agents, commands and MCP servers only. Host-specific hooks, apps, LSP servers and UI extensions are not OpenCode plugins.",
        ],
        install: { foreign: { format, catalog_url: url, entry } },
      }
    }),
  }
}

/** Codex keeps display metadata in each plugin's manifest, not in the catalog index. */
export async function enrichForeignMarketplaceCatalog(
  catalog: MarketplaceCatalog,
  fetcher: MarketplaceFetch,
  signal: AbortSignal,
): Promise<MarketplaceCatalog> {
  const items: MarketplaceCatalogItem[] = []
  // Bound raw-GitHub traffic, and share one deadline for the entire optional metadata pass.
  for (const batch of Array.from({ length: Math.ceil(catalog.items.length / 4) }, (_, index) =>
    catalog.items.slice(index * 4, index * 4 + 4),
  )) {
    items.push(
      ...(await Promise.all(
        batch.map(async (item) => {
          const plugin = item.install.foreign
          if (plugin?.format !== "codex" || signal.aborted) return item
          try {
            const location = pluginLocation(plugin)
            const response = await fetcher(repositoryAsset(location, ".codex-plugin/plugin.json"), { signal })
            if (!response.ok) return item
            const manifest = object(await response.json(), "plugin manifest")
            const display = manifest.interface === undefined ? {} : object(manifest.interface, "plugin.interface")
            const override =
              plugin.entry.interface === undefined ? {} : object(plugin.entry.interface, "plugin.interface")
            return {
              ...item,
              ...presentation({ ...manifest, ...plugin.entry, interface: { ...display, ...override } }, plugin),
            }
          } catch {
            // Missing, uncached or malformed optional metadata must not hide an installable listing.
            return item
          }
        }),
      )),
    )
  }
  return { ...catalog, items }
}

function presentation(
  config: Record<string, unknown>,
  plugin: ForeignMarketplacePlugin,
): Partial<MarketplaceCatalogItem> {
  const display = config.interface === undefined ? {} : object(config.interface, "plugin.interface")
  const name = optionalText(display.displayName)
  const description = optionalText(display.shortDescription) ?? optionalText(config.description)
  const version = optionalText(config.version)
  const logo = display.logo ?? display.composerIcon ?? config.icon
  const icon =
    typeof logo === "string" ? { "src-light": logo } : logo === undefined ? undefined : object(logo, "plugin logo")
  const asset = (value: unknown) => {
    const text = optionalText(value)
    if (!text) return undefined
    if (/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(text)) return text
    if (/^https?:\/\//i.test(text)) {
      if (!URL.canParse(text)) return undefined
      const url = new URL(text)
      return url.username || url.password ? undefined : url.href
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(text) || text.startsWith("//")) return undefined
    if (path.posix.isAbsolute(text) || /[\\\u0000]/.test(text)) return undefined
    const location = pluginLocation(plugin)
    const target = path.posix.normalize(path.posix.join(location.path, text))
    if (target === ".." || target.startsWith("../")) return undefined
    return repositoryAsset(location, text)
  }
  const light = asset(icon?.["src-light"])
  const dark = asset(icon?.["src-dark"])
  const color = optionalText(display.brandColor)
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(version ? { version } : {}),
    ...(light ? { icon: { "src-light": light, ...(dark ? { "src-dark": dark } : {}) } } : {}),
    ...(color && /^#[a-f\d]{6}$/i.test(color) ? { brand_color: color } : {}),
  }
}

function repositoryAsset(location: ReturnType<typeof pluginLocation>, file: string) {
  return `https://raw.githubusercontent.com/${location.repo}/${encodeURIComponent(location.ref)}/${repositoryPath(location.path, file).split("/").map(encodeURIComponent).join("/")}`
}

export async function resolveForeignMarketplacePlan(
  plan: MarketplaceInstallPlan,
  fetcher: MarketplaceFetch,
): Promise<{ plan: MarketplaceInstallPlan; warnings: string[] }> {
  if (!plan.foreign) return { plan, warnings: [] as string[] }
  const plugin = plan.foreign
  const location = pluginLocation(plugin)
  const json = async (url: string) => {
    const response = await fetcher(url, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status} loading ${url}`)
    return object(await response.json(), url)
  }
  // Resolve moving refs once. Every manifest and asset below uses this commit,
  // including bundles whose catalog explicitly pins a SHA.
  const commit = await json(`https://api.github.com/repos/${location.repo}/commits/${encodeURIComponent(location.ref)}`)
  const sha = requiredText(commit.sha, "GitHub commit SHA")
  if (!/^[a-f\d]{40}$/i.test(sha)) throw new Error("Invalid GitHub commit SHA")
  const tree = await json(`https://api.github.com/repos/${location.repo}/git/trees/${sha}?recursive=1`)
  if (tree.truncated) throw new Error("GitHub repository file listing is truncated; cannot safely import this bundle")
  if (!Array.isArray(tree.tree)) throw new Error("Invalid GitHub repository file listing")
  const files = tree.tree.flatMap((value) => {
    const entry = object(value, "GitHub tree entry")
    if (entry.type !== "blob" || entry.mode === "120000") return []
    return [requiredText(entry.path, "GitHub file path")]
  })
  const raw = (file: string) =>
    `https://raw.githubusercontent.com/${location.repo}/${sha}/${file.split("/").map(encodeURIComponent).join("/")}`
  const resolve = (file: string) => repositoryPath(location.path, file)
  const manifestPath = [
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    ".github/plugin/plugin.json",
    "plugin.json",
  ]
    .map(resolve)
    .find((file) => files.includes(file))
  const manifest = manifestPath ? await json(raw(manifestPath)) : {}
  // Marketplace entries may declare/override components without a manifest.
  const config = { ...manifest, ...plugin.entry }
  const extensions = config.extensions === undefined ? {} : object(config.extensions, "plugin.extensions")
  const copilot =
    extensions["com.github.awesome-copilot"] === undefined
      ? {}
      : object(extensions["com.github.awesome-copilot"], "Copilot components")
  const warnings = ["hooks", "lspServers", "apps"]
    .filter((key) => config[key] !== undefined)
    .map((key) => `Not imported: ${key}`)
  if (
    copilot.extensions !== undefined ||
    Object.keys(extensions).some((key) => !["com.github.awesome-copilot", "com.github.copilot"].includes(key))
  )
    warnings.push("Not imported: host-specific UI extensions")
  const select = (kind: string, fallback: string) => {
    const value = config[kind] ?? copilot[kind]
    const roots =
      value === undefined ? [fallback] : typeof value === "string" ? [value] : textArray(value, `plugin.${kind}`)
    // Awesome Copilot's extension index points into the repository-wide
    // agents/skills directories; standard manifest fields are plugin-relative.
    const targets = roots.map((root) =>
      config[kind] === undefined && copilot[kind] !== undefined ? repositoryPath("", root) : resolve(root),
    )
    if (value !== undefined) {
      for (const target of targets) {
        if (!files.some((file) => file === target || file.startsWith(target + "/")))
          warnings.push(`Not imported: missing ${kind} path ${target}`)
      }
    }
    return files.filter((file) => targets.some((target) => file === target || file.startsWith(target + "/")))
  }
  const text = async (file: string) => {
    const response = await fetcher(raw(file), { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status} loading ${file}`)
    return response.text()
  }
  const skillFiles = select("skills", "skills").filter((file) => path.posix.basename(file) === "SKILL.md")
  const skills = await Promise.all(
    skillFiles.map(async (file) => {
      const markdown = ConfigMarkdown.parse(await text(file))
      const data = object(markdown.data, "skill frontmatter")
      const root = path.posix.dirname(file)
      const name = optionalText(data.name) ?? path.posix.basename(root)
      return {
        id: identifier(name),
        name,
        ...(optionalText(data.description) ? { description: optionalText(data.description) } : {}),
        url: raw(file),
        files: Object.fromEntries(
          files.filter((file) => file.startsWith(root + "/")).map((file) => [file.slice(root.length + 1), raw(file)]),
        ),
      }
    }),
  )
  const markdownComponents = async (kind: "agents" | "commands") =>
    Object.fromEntries(
      await Promise.all(
        select(kind, kind)
          .filter((file) => file.endsWith(".md"))
          .map(async (file) => {
            const markdown = ConfigMarkdown.parse(await text(file))
            const data = object(markdown.data, `${kind} frontmatter`)
            const name = path.posix.basename(file).replace(/(?:\.agent)?\.md$/, "")
            // Foreign model/tool/permission names do not share OpenCode semantics.
            const description = optionalText(data.description)
            return [
              name,
              {
                ...(description ? { description } : {}),
                ...(kind === "agents"
                  ? { prompt: markdown.content, mode: "subagent" }
                  : { template: markdown.content }),
              },
            ] as const
          }),
      ),
    )
  const mcp: NonNullable<MarketplaceInstallPlan["mcp"]> = {}
  const mcpValue = config.mcpServers
  const mcpInputs =
    mcpValue === undefined
      ? files.includes(resolve(".mcp.json"))
        ? [".mcp.json"]
        : []
      : typeof mcpValue === "string"
        ? [mcpValue]
        : Array.isArray(mcpValue)
          ? textArray(mcpValue, "mcpServers")
          : [object(mcpValue, "mcpServers")]
  for (const input of mcpInputs) {
    const document = typeof input === "string" ? await json(raw(resolve(input))) : input
    const servers = document.mcpServers === undefined ? document : object(document.mcpServers, "mcpServers")
    for (const [name, value] of Object.entries(servers)) {
      const server = object(value, `MCP server ${name}`)
      if (typeof server.url === "string" && /^https?:\/\//.test(server.url)) {
        const headers = server.headers === undefined ? undefined : stringMap(server.headers, "MCP headers")
        if (server.url.includes("${") || Object.values(headers ?? {}).some((value) => value.includes("${"))) {
          warnings.push(`Not imported: MCP ${name} requires host-specific environment substitution`)
          continue
        }
        mcp[name] = { type: "remote", url: server.url, ...(headers ? { headers } : {}) }
        continue
      }
      if (typeof server.command === "string") {
        const command = [server.command, ...textArray(server.args ?? [], "MCP args")]
        const environment = server.env === undefined ? undefined : stringMap(server.env, "MCP environment")
        if (
          command.some(
            (part) =>
              part.includes("${") || part.startsWith("./") || part.startsWith("../") || files.includes(resolve(part)),
          ) ||
          Object.values(environment ?? {}).some((part) => part.includes("${"))
        ) {
          warnings.push(`Not imported: MCP ${name} requires host-specific paths or environment substitution`)
          continue
        }
        mcp[name] = { type: "local", command, ...(environment ? { environment } : {}) }
        continue
      }
      warnings.push(`Not imported: unsupported MCP server ${name}`)
    }
  }
  const agents = await markdownComponents("agents")
  const commands = await markdownComponents("commands")
  if (!skills.length && !Object.keys(agents).length && !Object.keys(commands).length && !Object.keys(mcp).length) {
    throw new Error(
      `This bundle has no compatible OpenCode components.${warnings.length ? " " + warnings.join("; ") : ""}`,
    )
  }
  return {
    plan: {
      foreign: plugin,
      ...(skills.length ? { skills: { items: skills } } : {}),
      ...(Object.keys(agents).length ? { agents } : {}),
      ...(Object.keys(commands).length ? { commands } : {}),
      ...(Object.keys(mcp).length ? { mcp } : {}),
    } satisfies MarketplaceInstallPlan,
    warnings,
  }
}

function pluginLocation(plugin: ForeignMarketplacePlugin) {
  const url = new URL(plugin.catalog_url)
  if (url.hostname !== "raw.githubusercontent.com")
    throw new Error("Foreign catalogs currently require a GitHub repository")
  const [owner, repo, ref] = url.pathname.slice(1).split("/")
  if (!owner || !repo || !ref) throw new Error("Invalid GitHub catalog URL")
  const source = plugin.entry.source
  if (typeof source === "string") return { repo: `${owner}/${repo}`, ref, path: repositoryPath("", source) }
  const value = object(source, "plugin.source")
  if (value.source === "local")
    return { repo: `${owner}/${repo}`, ref, path: repositoryPath("", requiredText(value.path, "plugin.source.path")) }
  if (!["github", "url", "git-subdir"].includes(requiredText(value.source, "plugin.source.source")))
    throw new Error("Unsupported foreign plugin source")
  const remote = requiredText(value.repo ?? value.url, "plugin source repository")
    .replace(/^https:\/\/github.com\//, "")
    .replace(/\.git$/, "")
  if (!/^[\w.-]+\/[\w.-]+$/.test(remote))
    throw new Error("Foreign plugin sources currently support GitHub repositories only")
  return {
    repo: remote,
    ref: optionalText(value.sha) ?? optionalText(value.ref) ?? "HEAD",
    path: repositoryPath("", optionalText(value.path) ?? "."),
  }
}

function repositoryPath(root: string, file: string) {
  const result = path.posix.normalize(path.posix.join(root, file)).replace(/\/$/, "")
  if (path.posix.isAbsolute(file) || result === ".." || result.startsWith("../") || /[\\\u0000]/.test(file))
    throw new Error(`Plugin path escapes its repository: ${file}`)
  return result === "." ? "" : result
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function requiredText(value: unknown, label: string) {
  const text = optionalText(value)
  if (!text) throw new Error(`${label} must be a nonempty string`)
  return text
}

function textArray(value: unknown, label: string) {
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string"))
    throw new Error(`${label} must be a string array`)
  return value
}

function stringMap(value: unknown, label: string) {
  return Object.fromEntries(
    Object.entries(object(value, label)).map(([key, value]) => [key, requiredText(value, `${label}.${key}`)]),
  )
}

function identifier(value: string) {
  if (value.length > 128 || /[:\u0000-\u001f\u007f]/.test(value))
    throw new Error(`Invalid marketplace identifier: ${value}`)
  return value
}
