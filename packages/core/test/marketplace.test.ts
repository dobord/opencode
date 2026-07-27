import { describe, expect, test } from "bun:test"
import {
  OFFICIAL_MARKETPLACE_SOURCE,
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
    expect(() =>
      parseMarketplaceCatalog({
        schema: "opencode.marketplace/v1",
        id: "ambiguous:catalog",
        name: "X",
        items: [],
      }),
    ).toThrow("cannot contain colons")
    expect(() =>
      parseMarketplaceCatalog({
        schema: "opencode.marketplace/v1",
        id: "large",
        name: "Large",
        items: Array.from({ length: 2_001 }, (_, index) => ({
          id: `item-${index}`,
          name: "Item",
          description: "Item",
          kind: "skill",
          version: "1",
          install: {},
        })),
      }),
    ).toThrow("too many items")
  })

  test("rejects oversized catalog responses before parsing", async () => {
    const source = createMarketplaceSource({ url: "https://example.test/catalog.json" })
    const result = await loadMarketplace({
      config: upsertMarketplaceSource({}, source),
      fetch: async () =>
        new Response("{}", {
          headers: { "content-length": String(2 * 1024 * 1024 + 1) },
        }),
    })

    expect(result.listings).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.message).toContain("exceeds")

    const streamed = await loadMarketplace({
      config: upsertMarketplaceSource({}, source),
      fetch: async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)),
    })
    expect(streamed.listings).toEqual([])
    expect(streamed.errors[0]?.message).toContain("exceeds")
  })

  test("rejects executable and credential-bearing metadata links", () => {
    expect(() =>
      parseMarketplaceCatalog({
        schema: "opencode.marketplace/v1",
        id: "links",
        name: "Links",
        publisher: { name: "Publisher", url: "data:text/html,unsafe" },
        items: [],
      }),
    ).toThrow("HTTP or HTTPS")
    expect(() =>
      parseMarketplaceCatalog({
        schema: "opencode.marketplace/v1",
        id: "links",
        name: "Links",
        items: [
          {
            id: "unsafe",
            name: "Unsafe",
            description: "Unsafe",
            kind: "skill",
            version: "1.0.0",
            homepage: "javascript:alert(1)",
            install: {},
          },
        ],
      }),
    ).toThrow("HTTP or HTTPS")
    expect(() =>
      parseMarketplaceCatalog({
        schema: "opencode.marketplace/v1",
        id: "links",
        name: "Links",
        homepage: "https://user:secret@example.test/catalog",
        items: [],
      }),
    ).toThrow("cannot contain credentials")
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
    const receipt = installed.config.marketplace?.installed?.[listing().key]
    expect(receipt?.version).toBe("1.0.0")
    expect(receipt?.snapshot).not.toHaveProperty("install")

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

  test("detects updates without offering catalog downgrades", () => {
    const installed = installMarketplaceItem({}, listing("1.0.0"), { force: true })
    if (!installed.ok) throw new Error("Expected install")
    expect(marketplaceStatus(installed.config, listing("1.0.0"))).toBe("installed")
    expect(marketplaceStatus(installed.config, listing("1.1.0"))).toBe("update")
    expect(marketplaceStatus(installed.config, listing("0.9.0"))).toBe("installed")

    const republished = listing("1.0.0")
    republished.item.description = "Republished metadata"
    expect(marketplaceStatus(installed.config, republished)).toBe("update")
    expect(marketplacePermissions(listing().item)).toContain("Runs third-party plugin code inside OpenCode")
    expect(marketplacePermissions(listing().item)).toContain("Starts or connects to MCP servers")
  })

  test("keeps installed items manageable after their catalog disappears", async () => {
    const installed = installMarketplaceItem({}, listing(), { force: true })
    if (!installed.ok) throw new Error("Expected install")

    const loaded = await loadMarketplace({ config: installed.config })
    const orphan = loaded.listings.find((item) => item.key === listing().key)
    expect(orphan?.orphaned).toBe(true)
    expect(orphan && marketplaceStatus(installed.config, orphan)).toBe("installed")

    const removed = uninstallMarketplaceItem(installed.config, listing().key)
    expect(removed.config.marketplace?.installed?.[listing().key]).toBeUndefined()
    expect(removed.config.plugin).toEqual([])
  })
})

describe("marketplace sources", () => {
  test("adds, disables, and removes catalogs without hiding the built-in source", () => {
    const source = createMarketplaceSource({ url: "github:example/catalog", trust: "community" })
    const added = upsertMarketplaceSource({}, source)
    expect(marketplaceSources(added).map((item) => item.id)).toEqual(["opencode", source.id])
    expect(source.url).toBe("https://raw.githubusercontent.com/example/catalog/HEAD/.opencode/marketplace.json")

    const disabled = toggleMarketplaceSource(added, source.id, false)
    expect(marketplaceSources(disabled).find((item) => item.id === source.id)?.enabled).toBe(false)

    const removed = removeMarketplaceSource(disabled, source.id)
    expect(marketplaceSources(removed).map((item) => item.id)).toEqual(["opencode"])
    expect(removeMarketplaceSource(removed, OFFICIAL_MARKETPLACE_SOURCE.id)).toEqual(removed)
  })

  test("does not let configured catalogs spoof official or verified provenance", () => {
    const spoofed = upsertMarketplaceSource({}, {
      id: OFFICIAL_MARKETPLACE_SOURCE.id,
      name: "Not OpenCode",
      url: "https://evil.example/catalog.json",
      trust: "official",
    })
    expect(marketplaceSources(spoofed)[0]).toEqual(OFFICIAL_MARKETPLACE_SOURCE)

    const legacy = upsertMarketplaceSource(spoofed, {
      id: "legacy-verified",
      name: "Legacy",
      url: "https://example.test/catalog.json",
      trust: "verified",
    })
    expect(marketplaceSources(legacy).find((source) => source.id === "legacy-verified")?.trust).toBe("community")
  })

  test("requires HTTPS except for loopback development catalogs", () => {
    expect(() => createMarketplaceSource({ url: "http://example.test/catalog.json" })).toThrow("must use HTTPS")
    expect(() => createMarketplaceSource({ url: "https://user:secret@example.test/catalog.json" })).toThrow(
      "cannot contain credentials",
    )
    expect(createMarketplaceSource({ url: "http://127.0.0.1:4096/catalog.json" }).url).toBe(
      "http://127.0.0.1:4096/catalog.json",
    )
    expect(createMarketplaceSource({ url: "https://example.test/catalog.json#ignored" }).url).toBe(
      "https://example.test/catalog.json",
    )
  })
})
