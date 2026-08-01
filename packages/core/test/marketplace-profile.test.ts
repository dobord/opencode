import { expect, test } from "bun:test"
import { exportMarketplaceProfile } from "@opencode-ai/core/marketplace-profile"
import type { MarketplaceState } from "@opencode-ai/core/marketplace"

test("exports a deterministic portable profile without source credentials or receipts", () => {
  const state: MarketplaceState = {
    revision: 7,
    sources: [
      {
        id: "private",
        name: "Private",
        url: "https://example.test/marketplace.json",
        trust: "private",
        headers: { authorization: "Bearer secret" },
      },
    ],
    installed: {
      "private:tools:review": {
        source: "private",
        source_url: "https://example.test/marketplace.json",
        source_trust: "private",
        catalog: "tools",
        catalog_name: "Tools",
        item: "review",
        name: "Review",
        kind: "bundle",
        version: "2.1.0",
        fingerprint: "fingerprint",
        installed_at: "2026-07-29T00:00:00.000Z",
        updated_at: "2026-07-29T00:00:00.000Z",
        plan: {
          skills: {
            items: [
              { id: "review", name: "review", path: "skills/review" },
              { id: "release", name: "release", path: "skills/release" },
            ],
          },
          mcp: {
            docs: { type: "remote", url: "https://example.test/mcp" },
          },
        },
        receipt: { mcp: { docs: { existed: false } } },
        disabled_skills: ["release"],
        disabled_mcp: ["docs"],
      },
    },
  }

  const profile = exportMarketplaceProfile(state, {
    name: "team-review",
    generatedAt: "2026-07-29T00:00:00.000Z",
  })

  expect(profile).toEqual({
    schema: "opencode.marketplace.profile/v1",
    name: "team-review",
    generated_at: "2026-07-29T00:00:00.000Z",
    sources: [
      {
        id: "private",
        name: "Private",
        url: "https://example.test/marketplace.json",
        trust: "private",
      },
    ],
    packages: [
      expect.objectContaining({
        key: "private:tools:review",
        enabled: true,
        components: { skills: { release: false, review: true }, mcp: { docs: false } },
      }),
    ],
  })
  expect(JSON.stringify(profile)).not.toContain("secret")
  expect(JSON.stringify(profile)).not.toContain("receipt")
})
