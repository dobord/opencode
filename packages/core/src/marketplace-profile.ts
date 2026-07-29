import { marketplaceSkillComponents, type MarketplaceState, type MarketplaceTrust } from "./marketplace"

export type MarketplaceProfileSource = {
  id: string
  name: string
  url: string
  trust?: MarketplaceTrust
}

export type MarketplaceProfilePackage = {
  key: string
  source: string
  catalog: string
  item: string
  name: string
  kind: string
  version: string
  enabled: boolean
  components: {
    skills: Record<string, boolean>
    mcp: Record<string, boolean>
  }
}

export type MarketplaceProfile = {
  schema: "opencode.marketplace.profile/v1"
  name: string
  description?: string
  generated_at: string
  sources: MarketplaceProfileSource[]
  packages: MarketplaceProfilePackage[]
}

export function exportMarketplaceProfile(
  state: MarketplaceState,
  options: { name?: string; description?: string; generatedAt?: string } = {},
): MarketplaceProfile {
  const sources = new Map<string, MarketplaceProfileSource>()

  for (const source of state.sources ?? []) {
    sources.set(source.id, {
      id: source.id,
      name: source.name,
      url: source.url,
      ...(source.trust ? { trust: source.trust } : {}),
    })
  }

  for (const installed of Object.values(state.installed ?? {})) {
    if (sources.has(installed.source) || !installed.source_url) continue
    sources.set(installed.source, {
      id: installed.source,
      name: installed.catalog_name ?? installed.source,
      url: installed.source_url,
      ...(installed.source_trust ? { trust: installed.source_trust } : {}),
    })
  }

  const packages = Object.entries(state.installed ?? {})
    .map(([key, installed]) => {
      const disabledSkills = new Set(installed.disabled_skills ?? [])
      const disabledMcp = new Set(installed.disabled_mcp ?? [])
      return {
        key,
        source: installed.source,
        catalog: installed.catalog,
        item: installed.item,
        name: installed.name,
        kind: installed.kind,
        version: installed.version,
        enabled: installed.enabled !== false,
        components: {
          skills: Object.fromEntries(
            marketplaceSkillComponents(installed.plan)
              .map((component) => [component.id, !disabledSkills.has(component.id)] as const)
              .toSorted(([left], [right]) => left.localeCompare(right)),
          ),
          mcp: Object.fromEntries(
            Object.keys(installed.plan.mcp ?? {})
              .map((name) => [name, !disabledMcp.has(name)] as const)
              .toSorted(([left], [right]) => left.localeCompare(right)),
          ),
        },
      } satisfies MarketplaceProfilePackage
    })
    .toSorted((left, right) => left.key.localeCompare(right.key))

  return {
    schema: "opencode.marketplace.profile/v1",
    name: options.name?.trim() || "default",
    ...(options.description?.trim() ? { description: options.description.trim() } : {}),
    generated_at: options.generatedAt ?? new Date().toISOString(),
    sources: Array.from(sources.values()).toSorted((left, right) => left.id.localeCompare(right.id)),
    packages,
  }
}
