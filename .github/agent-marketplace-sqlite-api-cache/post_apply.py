from pathlib import Path


def must_replace(path: str, old: str, new: str):
    target = Path(path)
    text = target.read_text()
    if old not in text:
        raise SystemExit(f"Anchor not found in {path}: {old[:120]!r}")
    target.write_text(text.replace(old, new, 1))


schema = Path("packages/core/src/marketplace-schema.ts")
text = schema.read_text()
old = 'export const Profile = Schema.Unknown.annotate({ identifier: "MarketplaceProfile" })'
new = '''const ProfileSource = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  trust: Schema.optional(Trust),
})

const ProfilePackage = Schema.Struct({
  key: Schema.String,
  source: Schema.String,
  catalog: Schema.String,
  item: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  version: Schema.String,
  enabled: Schema.Boolean,
  components: Schema.Struct({
    skills: Schema.Record(Schema.String, Schema.Boolean),
    mcp: Schema.Record(Schema.String, Schema.Boolean),
  }),
})

export const Profile = Schema.Struct({
  schema: Schema.Literal("opencode.marketplace.profile/v1"),
  name: Schema.String,
  description: Schema.optional(Schema.String),
  generated_at: Schema.String,
  sources: Schema.Array(ProfileSource),
  packages: Schema.Array(ProfilePackage),
}).annotate({ identifier: "MarketplaceProfile" })'''
if old not in text:
    raise SystemExit("Marketplace profile schema anchor was not found")
text = text.replace(old, new, 1)
text = text.replace(
    'import { Schema } from "effect"\n',
    'import { Schema } from "effect"\nimport { NonNegativeInt } from "./schema"\n',
    1,
)
text = text.replace("Schema.Number", "NonNegativeInt")
schema.write_text(text)

cache_test = Path("packages/opencode/test/marketplace/cache.test.ts")
text = cache_test.read_text()
old = 'expect(await fs.readFile(`${item!.path}/SKILL.md`, "utf8")).toContain("Review the current diff")'
new = 'expect(yield* Effect.promise(() => fs.readFile(`${item!.path}/SKILL.md`, "utf8"))).toContain("Review the current diff")'
if old not in text:
    raise SystemExit("Marketplace cache test async anchor was not found")
cache_test.write_text(text.replace(old, new, 1))

must_replace(
    "packages/opencode/src/marketplace/registry.ts",
    '''        }),
      )
    })

    return Service.of''',
    '''        }),
      ).pipe(
        Effect.catch((error) => (error instanceof ConflictError ? Effect.fail(error) : Effect.die(error))),
      )
    })

    return Service.of''',
)

must_replace(
    "packages/opencode/src/marketplace/service.ts",
    'import { exportMarketplaceProfile } from "@opencode-ai/core/marketplace-profile"',
    'import { exportMarketplaceProfile, type MarketplaceProfile } from "@opencode-ai/core/marketplace-profile"',
)
must_replace(
    "packages/opencode/src/marketplace/service.ts",
    "readonly profileExport: (input?: { name?: string; description?: string }) => Effect.Effect<unknown>",
    "readonly profileExport: (input?: { name?: string; description?: string }) => Effect.Effect<MarketplaceProfile>",
)

must_replace(
    "packages/opencode/test/fixture/config.ts",
    "    getGlobal: () => Effect.succeed({}),\n",
    "    getGlobal: () => Effect.succeed({}),\n    getGlobalBase: () => Effect.succeed({}),\n",
)

for path in [
    "packages/opencode/test/server/httpapi-global.test.ts",
    "packages/opencode/test/server/httpapi-control-plane.test.ts",
]:
    must_replace(
        path,
        'import { Config } from "../../src/config/config"\n',
        'import { Config } from "../../src/config/config"\nimport { Service as MarketplaceService } from "../../src/marketplace/service"\n',
    )
    must_replace(
        path,
        'import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"\n',
        'import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"\nimport { marketplaceHandlers } from "../../src/server/routes/instance/httpapi/handlers/marketplace"\n',
    )
    must_replace(
        path,
        "Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),",
        "Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers, marketplaceHandlers]),",
    )
    must_replace(
        path,
        "  Layer.provide(Layer.mock(Config.Service)({})),\n",
        "  Layer.provide(Layer.mock(Config.Service)({})),\n  Layer.provide(Layer.mock(MarketplaceService)({})),\n",
    )

tui = Path("packages/tui/src/feature-plugins/system/marketplace.tsx")
text = tui.read_text()
old = '''async function unwrap<T>(request: Promise<{ data?: T; error?: unknown }>): Promise<T> {
  const result = await request
  if (result.error) throw new Error(errorMessage(result.error))
  if (result.data === undefined) throw new Error("Marketplace server returned no data")
  return result.data
}'''
new = '''async function unwrap<T>(request: PromiseLike<{ data?: unknown; error?: unknown }>): Promise<T> {
  const result = await request
  if (result.error) throw new Error(errorMessage(result.error))
  if (result.data === undefined) throw new Error("Marketplace server returned no data")
  return result.data as T
}'''
if old not in text:
    raise SystemExit("TUI unwrap anchor was not found")
text = text.replace(old, new, 1)
marker = '''const getView = (api: TuiPluginApi, refresh = false) =>
  unwrap<MarketplaceView>(refresh ? api.client.marketplace.refresh() : api.client.marketplace.get())
'''
helpers = '''const getView = (api: TuiPluginApi, refresh = false) =>
  unwrap<MarketplaceView>(refresh ? api.client.marketplace.refresh() : api.client.marketplace.get())

const planRequest = (api: TuiPluginApi, key: string) =>
  api.client.marketplace.plan({ marketplacePlanInput: { key } })

const installRequest = (
  api: TuiPluginApi,
  input: { key: string; expected_revision: number; force?: boolean; accept_untrusted?: boolean },
) => api.client.marketplace.install({ marketplaceInstallInput: input })

const updateAllRequest = (
  api: TuiPluginApi,
  input: { expected_revision: number; force?: boolean; accept_untrusted?: boolean },
) => api.client.marketplace.updateAll({ marketplaceUpdateAllInput: input })

const cachePruneRequest = (api: TuiPluginApi, input: { max_age_days?: number }) =>
  api.client.marketplace.cachePrune({ marketplaceCachePruneInput: input })

const toggleRequest = (
  api: TuiPluginApi,
  input: {
    key: string
    expected_revision: number
    component: "package" | "skill" | "mcp"
    id?: string
    enabled: boolean
  },
) => {
  const { key, ...marketplaceToggleInput } = input
  return api.client.marketplace.toggle({ key, marketplaceToggleInput })
}

const uninstallRequest = (api: TuiPluginApi, input: { key: string; expected_revision: number }) =>
  api.client.marketplace.uninstall({
    key: input.key,
    marketplaceRevisionInput: { expected_revision: input.expected_revision },
  })

const sourceAddRequest = (
  api: TuiPluginApi,
  input: {
    expected_revision: number
    url: string
    name?: string
    trust?: "community" | "private"
    headers?: Record<string, string>
  },
) => api.client.marketplace.sourceAdd({ marketplaceSourceAddInput: input })

const sourceToggleRequest = (
  api: TuiPluginApi,
  input: { id: string; expected_revision: number; enabled: boolean },
) =>
  api.client.marketplace.sourceToggle({
    id: input.id,
    marketplaceSourceToggleInput: {
      expected_revision: input.expected_revision,
      enabled: input.enabled,
    },
  })

const sourceRemoveRequest = (api: TuiPluginApi, input: { id: string; expected_revision: number }) =>
  api.client.marketplace.sourceRemove({
    id: input.id,
    marketplaceRevisionInput: { expected_revision: input.expected_revision },
  })
'''
if marker not in text:
    raise SystemExit("TUI marketplace request helper anchor was not found")
text = text.replace(marker, helpers, 1)
replacements = {
    "props.api.client.marketplace.plan({ key })": "planRequest(props.api, key)",
    "props.api.client.marketplace.install({": "installRequest(props.api, {",
    "props.api.client.marketplace.updateAll({": "updateAllRequest(props.api, {",
    "props.api.client.marketplace.cachePrune({": "cachePruneRequest(props.api, {",
    "props.api.client.marketplace.toggle({": "toggleRequest(props.api, {",
    "props.api.client.marketplace.uninstall({": "uninstallRequest(props.api, {",
    "props.api.client.marketplace.sourceAdd({": "sourceAddRequest(props.api, {",
    "props.api.client.marketplace.sourceToggle({": "sourceToggleRequest(props.api, {",
    "props.api.client.marketplace.sourceRemove({": "sourceRemoveRequest(props.api, {",
}
for old, new in replacements.items():
    if old not in text:
        raise SystemExit(f"TUI generated SDK call anchor was not found: {old}")
    text = text.replace(old, new)
tui.write_text(text)

sync = Path("packages/app/src/context/server-sync.tsx")
text = sync.read_text()
replacements = {
    "serverSDK.client.marketplace.plan(input)": "serverSDK.client.marketplace.plan({ marketplacePlanInput: input })",
    "serverSDK.client.marketplace.install(input)": "serverSDK.client.marketplace.install({ marketplaceInstallInput: input })",
    "serverSDK.client.marketplace.updateAll(input)": "serverSDK.client.marketplace.updateAll({ marketplaceUpdateAllInput: input })",
    "serverSDK.client.marketplace.sourceAdd(input)": "serverSDK.client.marketplace.sourceAdd({ marketplaceSourceAddInput: input })",
    "serverSDK.client.marketplace.profileExport(input)": "serverSDK.client.marketplace.profileExport({ marketplaceProfileExportInput: input })",
    "serverSDK.client.marketplace.cachePrune(input)": "serverSDK.client.marketplace.cachePrune({ marketplaceCachePruneInput: input })",
}
for old, new in replacements.items():
    if old not in text:
        raise SystemExit(f"Desktop generated SDK call anchor was not found: {old}")
    text = text.replace(old, new, 1)

must_replace(
    "packages/app/src/context/server-sync.tsx",
    "serverSDK.client.marketplace.uninstall(input).then((result) => result.data!)",
    '''serverSDK.client.marketplace
        .uninstall({
          key: input.key,
          marketplaceRevisionInput: { expected_revision: input.expected_revision },
        })
        .then((result) => result.data!)''',
)
must_replace(
    "packages/app/src/context/server-sync.tsx",
    "serverSDK.client.marketplace.toggle(input).then((result) => result.data!)",
    '''serverSDK.client.marketplace
        .toggle({
          key: input.key,
          marketplaceToggleInput: {
            expected_revision: input.expected_revision,
            component: input.component,
            id: input.id,
            enabled: input.enabled,
          },
        })
        .then((result) => result.data!)''',
)
must_replace(
    "packages/app/src/context/server-sync.tsx",
    "serverSDK.client.marketplace.sourceToggle(input).then((result) => result.data!)",
    '''serverSDK.client.marketplace
        .sourceToggle({
          id: input.id,
          marketplaceSourceToggleInput: {
            expected_revision: input.expected_revision,
            enabled: input.enabled,
          },
        })
        .then((result) => result.data!)''',
)
must_replace(
    "packages/app/src/context/server-sync.tsx",
    "serverSDK.client.marketplace.sourceRemove(input).then((result) => result.data!)",
    '''serverSDK.client.marketplace
        .sourceRemove({
          id: input.id,
          marketplaceRevisionInput: { expected_revision: input.expected_revision },
        })
        .then((result) => result.data!)''',
)
