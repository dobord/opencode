import { describe, expect, test } from "bun:test"
import {
  createMarketplaceSource,
  installMarketplaceItem,
  loadMarketplace,
  marketplacePermissions,
  marketplaceSources,
  marketplaceStatus,
  parseMarketplaceCatalog,
  removeMarketplaceSource,
  toggleMarketplaceSource,
  uninstallMarketplaceItem,
  upsertMarketplaceSource,
  type MarketplaceHostConfig,
  type MarketplaceListing,
} from "@opencode-ai/core/marketplace"

function listing(version = "1.0.0"): MarketplaceListing {
  return {
    key: "community:tools:review",
    source: {
      id: "community",
      name: "Community",
      url: "https://example.test/catalog.json",
      trust: "community",
    },
    catalog: {
      schema: "opencode.marketplace/v1",
      id: "tools",
      name: "Tools",
      items: [],
    },
    item: {
      id: "review",
      name: "Review kit",
      description: "Installs a plugin, skill source, agent, command, and MCP server.",
      kind: "bundle",
      version,
      install: {
        plugins: [["example-plugin@2.0.0", { strict: true }]],
        skills: { urls: ["https://example.test/skills/"] },
        agents: { reviewer: { description: "Review changes", mode: "subagent" } },
        commands: { review: { template: "Review the current changes" } },
        mcp: { docs: { type: "remote", url: "https://example.test/mcp" } },
        instructions: [".opencode/review.md"],
      },
    },
  }
}

describe("marketplace catalogs", () => {
  test("loads enabled catalogs and reports source failures", async () => {
    const source = createMarketplaceSource({ url: "https://example.test/catalog.json", name: "Example" })
    const config = upsertMarketplaceSource({}, source)
    const result = await loadMarketplace({
      config,
      fetch: async (url) => {
        if (String(url).includes("example.test")) {
          return Response.json({
            schema: "opencode.marketplace/v1",
            id: "example",
            name: "Example",
            items: [
              {
                id: "skill",
                name: "Skill",
                description: "A reusable skill",
                kind: "skill",
                version: "1.0.0",
                install: { skills: { urls: ["https://example.test/skills/"] } },
              },
            ],
          })
        }
        return new Response("not found", { status: 404 })
      },
    })

    expect(result.errors).toEqual([])
    expect(result.listings.map((item) => item.key)).toEqual([`${source.id}:example:skill`])
    expect(result.listings[0]?.source.name).toBe("Example")
  })

  test("validates catalog entries", () => {
    expect(() => parseMarketplaceCatalog({ schema: "other", id: "x", name: "X", items: [] })).toThrow(
      "Unsupported marketplace schema",
    )
    expect(() =>
      parseMarketplaceCatalog({
        schema: "opencode.marketplace/v1",
        id: "x",
        name: "X",
        items: [
          { id: "same", name: "One", description: "One", kind: "skill", version: "1", install: {} },
          { id: "same", name: "Two", description: "Two", kind: "skill", version: "1", install: {} },
        ],
      }),
    ).toThrow("Duplicate marketplace item id")
  })
})

describe("marketplace installation", () => {
  test("detects conflicts, force-installs, and restores previous values", () => {
    const config: MarketplaceHostConfig = {
      plugin: [["example-plugin@1.0.0", { strict: false }]],
      agent: { reviewer: { description: "Existing" } },
      command: { keep: { template: "Keep me" } },
    }
    const conflict = installMarketplaceItem(config, listing())
    expect(conflict.ok).toBe(false)
    if (conflict.ok) throw new Error("Expected conflict")
    expect(conflict.conflicts.map((item) => item.path)).toEqual(["plugin.example-plugin", "agent.reviewer"])

    const installed = installMarketplaceItem(config, listing(), { force: true })
    expect(installed.ok).toBe(true)
    if (!installed.ok) throw new Error("Expected install")
    expect(installed.config.plugin).toEqual([["example-plugin@2.0.0", { strict: true }]])
    expect(installed.config.agent?.reviewer).toEqual({ description: "Review changes", mode: "subagent" })
    expect(installed.config.command?.keep).toEqual({ template: "Keep me" })
    expect(installed.config.marketplace?.installed?.[listing().key]?.version).toBe("1.0.0")

    const removed = uninstallMarketplaceItem(installed.config, listing().key)
    expect(removed.preserved).toEqual([])
    expect(removed.config.plugin).toEqual([["example-plugin@1.0.0", { strict: false }]])
    expect(removed.config.agent?.reviewer).toEqual({ description: "Existing" })
    expect(removed.config.command).toEqual({ keep: { template: "Keep me" } })
    expect(removed.config.skills?.urls).toEqual([])
    expect(removed.config.marketplace?.installed?.[listing().key]).toBeUndefined()
  })

  test("preserves settings edited after installation", () => {
    const installed = installMarketplaceItem({}, listing(), { force: true })
    if (!installed.ok) throw new Error("Expected install")
    installed.config.agent = { ...installed.config.agent, reviewer: { description: "User override" } }
    installed.config.plugin = ["example-plugin@3.0.0"]

    const removed = uninstallMarketplaceItem(installed.config, listing().key)
    expect(removed.preserved).toEqual(["plugin.example-plugin", "agent.reviewer"])
    expect(removed.config.plugin).toEqual(["example-plugin@3.0.0"])
    expect(removed.config.agent?.reviewer).toEqual({ description: "User override" })
  })

  test("detects updates and describes permissions", () => {
    const installed = installMarketplaceItem({}, listing("1.0.0"), { force: true })
    if (!installed.ok) throw new Error("Expected install")
    expect(marketplaceStatus(installed.config, listing("1.0.0"))).toBe("installed")
    expect(marketplaceStatus(installed.config, listing("1.1.0"))).toBe("update")
    expect(marketplacePermissions(listing().item)).toContain("Runs third-party plugin code inside OpenCode")
    expect(marketplacePermissions(listing().item)).toContain("Starts or connects to MCP servers")
  })
})

describe("marketplace sources", () => {
  test("adds, disables, and removes catalogs without hiding the built-in source", () => {
    const source = createMarketplaceSource({ url: "github:example/catalog", trust: "verified" })
    const added = upsertMarketplaceSource({}, source)
    expect(marketplaceSources(added).map((item) => item.id)).toEqual(["opencode", source.id])
    expect(source.url).toBe("https://raw.githubusercontent.com/example/catalog/HEAD/.opencode/marketplace.json")

    const disabled = toggleMarketplaceSource(added, source.id, false)
    expect(marketplaceSources(disabled).find((item) => item.id === source.id)?.enabled).toBe(false)

    const removed = removeMarketplaceSource(disabled, source.id)
    expect(marketplaceSources(removed).map((item) => item.id)).toEqual(["opencode"])
  })
})
