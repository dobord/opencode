import { describe, expect, test } from "bun:test"
import {
  createMarketplaceSource,
  loadMarketplace,
  marketplaceFingerprint,
  parseMarketplaceCatalog,
} from "../../src/marketplace.js"
import {
  foreignSkillRepositories,
  parseForeignMarketplaceCatalog,
  resolveForeignMarketplacePlan,
} from "../../src/marketplace/foreign.js"
import type { MarketplaceFetch, MarketplaceInstallPlan } from "../../src/marketplace.js"

const sources = [
  ["github/awesome-copilot", ".github/plugin/marketplace.json", "copilot"],
  ["anthropics/claude-plugins-official", ".claude-plugin/marketplace.json", "claude"],
  ["anthropics/claude-plugins-community", ".claude-plugin/marketplace.json", "claude"],
  ["openai/plugins", ".agents/plugins/marketplace.json", "codex"],
  ["openai/community-plugins", ".agents/plugins/marketplace.json", "codex"],
] as const
const sha = "a".repeat(40)

describe("foreign skill repository grouping", () => {
  test("groups Cloudflare-sized and Superpowers-sized skill trees into one pinned repository transfer", () => {
    const input = fixture({})
    const paths = [359, 65].flatMap((count, index) =>
      Array.from({ length: count }, (_, file) => `skills/skill-${index}/references/file-${file}.md`),
    )
    const raw = (file: string) => `https://raw.githubusercontent.com/acme/catalog/${sha}/${file}`
    input.plan.skills = {
      items: [0, 1].map((index) => ({
        id: `skill-${index}`,
        name: `skill-${index}`,
        files: Object.fromEntries(
          paths
            .filter((file) => file.startsWith(`skills/skill-${index}/`))
            .map((file) => [file.slice(`skills/skill-${index}/`.length), raw(file)]),
        ),
      })),
    }
    const result = foreignSkillRepositories(input.plan)
    expect(result).toHaveLength(1)
    expect(result[0].remote).toBe("https://github.com/acme/catalog.git")
    expect(result[0].commit).toBe(sha)
    expect(result[0].files.size).toBe(424)
    expect(result[0].files.get(raw(paths[0]))).toBe(paths[0])
  })

  test("does not change native skill sources", () => {
    const result = foreignSkillRepositories({
      skills: { items: [{ id: "review", name: "review", files: { "SKILL.md": "https://example.com/SKILL.md" } }] },
    })
    expect(result).toEqual([])
  })

  test("keeps different repository commits separate", () => {
    const input = fixture({})
    const revisions = [sha, "b".repeat(40)]
    input.plan.skills = {
      items: revisions.map((revision, index) => ({
        id: `review-${index}`,
        name: `review-${index}`,
        files: { "SKILL.md": `https://raw.githubusercontent.com/acme/catalog/${revision}/skills/review/SKILL.md` },
      })),
    }
    const result = foreignSkillRepositories(input.plan)
    expect(result.map((entry) => entry.commit)).toEqual(revisions)
    expect(result.map((entry) => entry.files.size)).toEqual([1, 1])
  })
})

function fixture(input: {
  manifest?: Record<string, unknown>
  files?: Record<string, string>
  source?: unknown
  format?: "claude" | "copilot" | "codex"
}) {
  const files = {
    "plugins/review/.claude-plugin/plugin.json": JSON.stringify(input.manifest ?? {}),
    ...input.files,
  }
  const requests: string[] = []
  const fetcher: MarketplaceFetch = async (input) => {
    const url = String(input)
    requests.push(url)
    if (url.includes("/commits/")) return Response.json({ sha })
    if (url.includes("/git/trees/"))
      return Response.json({ tree: Object.keys(files).map((path) => ({ path, type: "blob", mode: "100644" })) })
    const file = decodeURIComponent(url.split(`/${sha}/`)[1] ?? "")
    const content = files[file as keyof typeof files]
    return content === undefined ? new Response("not found", { status: 404 }) : new Response(content)
  }
  const plan: MarketplaceInstallPlan = {
    foreign: {
      format: input.format ?? "claude",
      catalog_url: "https://raw.githubusercontent.com/acme/catalog/HEAD/.claude-plugin/marketplace.json",
      entry: { name: "review", source: input.source ?? "./plugins/review" },
    },
  }
  return { plan, fetcher, requests }
}

describe("foreign marketplace catalogs", () => {
  test.each(sources)("discovers %s from a bare repository and its persisted native URL", async (repo, file, format) => {
    const requests: string[] = []
    const fetcher: MarketplaceFetch = async (input) => {
      const url = String(input)
      requests.push(url)
      if (!url.endsWith(file)) return new Response("not found", { status: 404 })
      return Response.json({
        name: "catalog",
        plugins: [{ name: "review", source: { source: "local", path: "./plugins/review" } }],
      })
    }
    const source = createMarketplaceSource({ url: `https://github.com/${repo}` })
    for (const url of [`https://github.com/${repo}`, source.url]) {
      const result = await loadMarketplace({
        config: { marketplace: { sources: [{ ...source, url }] } },
        fetch: fetcher,
      })
      expect(result.errors).toEqual([])
      const listing = result.listings.find((listing) => listing.source.id === source.id)
      expect(listing?.item.install.foreign?.format).toBe(format)
      expect(listing?.catalog_url).toBe(`https://raw.githubusercontent.com/${repo}/HEAD/${file}`)
    }
    expect(requests.some((url) => url.endsWith("/.opencode/marketplace.json"))).toBe(true)
    expect(requests.every((url) => !url.includes("plugin.json"))).toBe(true)
  })

  test("accepts the complete Anthropic community catalog size without truncation", () => {
    const catalog = parseForeignMarketplaceCatalog(
      {
        name: "community",
        plugins: Array.from({ length: 2283 }, (_, index) => ({ name: `plugin-${index}`, source: "./plugin" })),
      },
      "https://raw.githubusercontent.com/anthropics/claude-plugins-community/HEAD/.claude-plugin/marketplace.json",
    )
    expect(catalog?.items).toHaveLength(2283)
  })

  test("keeps native catalogs first when a repository publishes both formats", async () => {
    const source = createMarketplaceSource({ url: "github:acme/plugins" })
    const requests: string[] = []
    const result = await loadMarketplace({
      config: { marketplace: { sources: [source] } },
      fetch: async (input) => {
        requests.push(String(input))
        return Response.json({ schema: "opencode.marketplace/v1", id: "native", name: "Native", items: [] })
      },
    })
    expect(result.errors).toEqual([])
    expect(requests).toHaveLength(1)
  })

  test("preserves native schema validation", () => {
    expect(() => parseMarketplaceCatalog({ name: "foreign", plugins: [] })).toThrow("Unsupported marketplace schema")
  })
})

describe("foreign component resolution", () => {
  test("loads Codex metadata and skills from a local source descriptor", async () => {
    const input = fixture({
      format: "codex",
      source: { source: "local", path: "./plugins/review" },
      files: {
        "plugins/review/.codex-plugin/plugin.json": JSON.stringify({ skills: "./skills/", apps: "./.app.json" }),
        "plugins/review/skills/review/SKILL.md": "---\nname: review\ndescription: Review code\n---\nReview",
      },
    })
    const result = await resolveForeignMarketplacePlan(input.plan, input.fetcher)
    expect(result.plan.skills?.items?.[0].name).toBe("review")
    expect(result.warnings).toContain("Not imported: apps")
  })

  test("imports declarative components at one commit and preserves skill assets", async () => {
    const input = fixture({
      manifest: { hooks: "./hooks.json", lspServers: { server: {} } },
      files: {
        "plugins/review/skills/review/SKILL.md":
          "---\nname: review\ndescription: Review code\n---\nUse scripts/check.py",
        "plugins/review/skills/review/scripts/check.py": "print('check')",
        "plugins/review/agents/reviewer.md":
          "---\ndescription: Reviews code\nmodel: foreign-model\ntools: Read, Edit\n---\nReview changes",
        "plugins/review/commands/review.md": "---\ndescription: Review command\n---\nReview $ARGUMENTS",
        "plugins/review/.mcp.json": JSON.stringify({
          mcpServers: {
            remote: { type: "http", url: "https://mcp.example.com/mcp" },
            local: { command: "npx", args: ["-y", "example-mcp"], env: { MODE: "read" } },
            unsupported: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js"] },
          },
        }),
      },
    })
    const result = await resolveForeignMarketplacePlan(input.plan, input.fetcher)
    expect(result.plan.plugins).toBeUndefined()
    expect(result.plan.skills?.items?.[0].files?.["scripts/check.py"]).toContain(
      `/${sha}/plugins/review/skills/review/scripts/check.py`,
    )
    expect(result.plan.agents?.reviewer).toEqual({
      description: "Reviews code",
      mode: "subagent",
      prompt: "Review changes",
    })
    expect(result.plan.commands?.review).toEqual({ description: "Review command", template: "Review $ARGUMENTS" })
    expect(result.plan.mcp?.remote).toEqual({ type: "remote", url: "https://mcp.example.com/mcp" })
    expect(result.plan.mcp?.local).toEqual({
      type: "local",
      command: ["npx", "-y", "example-mcp"],
      environment: { MODE: "read" },
    })
    expect(result.plan.mcp?.unsupported).toBeUndefined()
    expect(result.warnings).toContain("Not imported: hooks")
    expect(result.warnings).toContain("Not imported: lspServers")
    expect(
      input.requests
        .filter((url) => url.includes("raw.githubusercontent.com"))
        .every((url) => url.includes(`/${sha}/`)),
    ).toBe(true)
  })

  test("honors pinned external GitHub subdirectories", async () => {
    const input = fixture({
      source: {
        source: "git-subdir",
        url: "https://github.com/vendor/plugin.git",
        path: "plugins/review",
        ref: "release",
        sha,
      },
      files: { "plugins/review/.mcp.json": '{"mcpServers":{"test":{"url":"https://example.com/mcp"}}}' },
    })
    await resolveForeignMarketplacePlan(input.plan, input.fetcher)
    expect(input.requests[0]).toBe(`https://api.github.com/repos/vendor/plugin/commits/${sha}`)
  })

  test("imports Copilot skill paths outside the plugin directory but inside the repository", async () => {
    const input = fixture({
      format: "copilot",
      manifest: { extensions: { "com.github.awesome-copilot": { skills: ["./skills/shared"] } } },
      files: {
        "skills/shared/SKILL.md": "---\nname: shared\ndescription: Shared skill\n---\nShared",
        "skills/shared/references/guide.md": "Guide",
      },
    })
    const result = await resolveForeignMarketplacePlan(input.plan, input.fetcher)
    expect(result.plan.skills?.items?.[0].name).toBe("shared")
    expect(result.plan.skills?.items?.[0].files?.["references/guide.md"]).toContain(
      "/skills/shared/references/guide.md",
    )
  })

  test("resolves standard relative component paths against the plugin, not the catalog directory", async () => {
    const input = fixture({
      manifest: { skills: ["../../skills/shared"] },
      files: { "skills/shared/SKILL.md": "---\nname: shared\ndescription: Shared\n---\nShared" },
    })
    const result = await resolveForeignMarketplacePlan(input.plan, input.fetcher)
    expect(result.plan.skills?.items?.[0].url).toContain(`/${sha}/skills/shared/SKILL.md`)
  })

  test("rejects apps-only and hooks-only bundles rather than installing an empty plan", async () => {
    const input = fixture({ manifest: { apps: "./.app.json", hooks: "./hooks.json" } })
    await expect(resolveForeignMarketplacePlan(input.plan, input.fetcher)).rejects.toThrow(
      "no compatible OpenCode components",
    )
  })

  test("rejects paths escaping the repository", async () => {
    const input = fixture({ manifest: { skills: ["../../../outside"] } })
    await expect(resolveForeignMarketplacePlan(input.plan, input.fetcher)).rejects.toThrow("escapes its repository")
  })

  test("does not mark lazy component resolution as a catalog update", async () => {
    const input = fixture({ files: { "plugins/review/skills/review/SKILL.md": "---\nname: review\n---\nReview" } })
    const item = {
      id: "review",
      name: "Review",
      description: "Review",
      kind: "bundle" as const,
      version: "unversioned",
      install: input.plan,
    }
    const resolved = await resolveForeignMarketplacePlan(input.plan, input.fetcher)
    expect(marketplaceFingerprint({ ...item, install: resolved.plan })).toBe(marketplaceFingerprint(item))
  })
})
