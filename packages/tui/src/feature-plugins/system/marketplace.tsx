import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Config } from "@opencode-ai/sdk/v2"
import {
  OFFICIAL_MARKETPLACE_SOURCE,
  createMarketplaceSource,
  installMarketplaceItem,
  loadMarketplace,
  marketplacePermissions,
  marketplacePlanSummary,
  marketplaceSources,
  marketplaceStatus,
  removeMarketplaceSource,
  toggleMarketplaceSource,
  uninstallMarketplaceItem,
  upsertMarketplaceSource,
  type MarketplaceHostConfig,
  type MarketplaceListing,
} from "@opencode-ai/core/marketplace"
import { createMemo, createResource, Show } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { useBindings } from "../../keymap"
import { errorMessage } from "../../util/error"
import type { BuiltinTuiPlugin } from "../builtins"

const id = "internal:marketplace"

async function readConfig(api: TuiPluginApi) {
  const result = await api.client.global.config.get()
  if (result.error) throw new Error(errorMessage(result.error))
  return (result.data ?? api.state.config) as Config & MarketplaceHostConfig
}

async function writeConfig(api: TuiPluginApi, config: MarketplaceHostConfig) {
  const result = await api.client.global.config.update({ config: config as Config })
  if (result.error) throw new Error(errorMessage(result.error))
  return result.data as Config & MarketplaceHostConfig
}

function confirm(api: TuiPluginApi, title: string, message: string) {
  return new Promise<boolean>((resolve) => {
    api.ui.dialog.replace(
      () => (
        <api.ui.DialogConfirm
          title={title}
          message={message}
          onConfirm={() => resolve(true)}
          onCancel={() => resolve(false)}
        />
      ),
      () => resolve(false),
    )
  })
}

function prompt(api: TuiPluginApi, title: string, placeholder: string) {
  return new Promise<string | undefined>((resolve) => {
    api.ui.dialog.replace(
      () => (
        <api.ui.DialogPrompt
          title={title}
          placeholder={placeholder}
          onConfirm={(value) => resolve(value)}
          onCancel={() => resolve(undefined)}
        />
      ),
      () => resolve(undefined),
    )
  })
}

function statusText(api: TuiPluginApi, listing: MarketplaceListing, config: MarketplaceHostConfig) {
  const status = marketplaceStatus(config, listing)
  const color =
    status === "update"
      ? api.theme.current.warning
      : status === "installed"
        ? api.theme.current.success
        : api.theme.current.textMuted
  return <span style={{ fg: color }}>{status}</span>
}

function details(listing: MarketplaceListing) {
  return [
    listing.item.description,
    `publisher: ${listing.item.publisher?.name ?? listing.catalog.publisher?.name ?? "unknown"}`,
    `version: ${listing.item.version}`,
    `catalog: ${listing.source.name} (${listing.source.trust ?? "community"})`,
    listing.orphaned ? "catalog status: unavailable; receipt can still be uninstalled" : undefined,
    `changes: ${marketplacePlanSummary(listing.item.install)}`,
    ...marketplacePermissions(listing.item).map((permission) => `permission: ${permission}`),
  ].filter((value): value is string => value !== undefined)
}

function View(props: { api: TuiPluginApi }) {
  const [data, actions] = createResource(async () => {
    const config = await readConfig(props.api)
    return { config, catalog: await loadMarketplace({ config }) }
  })
  const rows = createMemo<DialogSelectOption<string>[]>(() =>
    (data()?.catalog.listings ?? []).map((listing) => ({
      title: listing.item.name,
      value: listing.key,
      category: `${listing.item.kind} · ${listing.source.name}`,
      description: listing.item.description,
      details: details(listing),
      footer: statusText(props.api, listing, data()!.config),
    })),
  )
  const selected = (key: string) => data()?.catalog.listings.find((listing) => listing.key === key)

  async function save(next: MarketplaceHostConfig, message: string) {
    try {
      await writeConfig(props.api, next)
      props.api.ui.toast({ variant: "success", message })
      await actions.refetch()
    } catch (error) {
      props.api.ui.toast({ variant: "error", message: errorMessage(error) })
    }
  }

  async function apply(key: string) {
    const listing = selected(key)
    const config = data()?.config
    if (!listing || !config) return
    const status = marketplaceStatus(config, listing)
    if (status === "installed") {
      if (
        !(await confirm(
          props.api,
          `Remove ${listing.item.name}?`,
          "Only unchanged settings from its installation receipt will be removed.",
        ))
      ) {
        show(props.api)
        return
      }
      const result = uninstallMarketplaceItem(config, listing.key)
      await save(result.config, `Removed ${listing.item.name}`)
      if (result.preserved.length) {
        props.api.ui.toast({ variant: "warning", message: `Kept modified settings: ${result.preserved.join(", ")}` })
      }
      show(props.api)
      return
    }

    const planned = installMarketplaceItem(config, listing)
    const conflicts = planned.ok ? [] : planned.conflicts
    const permissions = marketplacePermissions(listing.item)
    const trust = listing.source.trust ?? "community"
    const message = [
      marketplacePlanSummary(listing.item.install),
      !["official", "verified"].includes(trust) ? `Catalog trust: ${trust}.` : undefined,
      permissions.length ? `Capabilities: ${permissions.join("; ")}.` : undefined,
      conflicts.length ? `Replace: ${conflicts.map((item) => item.path).join(", ")}.` : undefined,
    ]
      .filter((value): value is string => value !== undefined)
      .join("\n")
    if (!(await confirm(props.api, `${status === "update" ? "Update" : "Install"} ${listing.item.name}?`, message))) {
      show(props.api)
      return
    }
    const result = installMarketplaceItem(config, listing, { force: conflicts.length > 0 })
    if (!result.ok) {
      props.api.ui.toast({
        variant: "error",
        message: `Conflicting settings: ${result.conflicts.map((item) => item.path).join(", ")}`,
      })
      show(props.api)
      return
    }
    await save(result.config, `${status === "update" ? "Updated" : "Installed"} ${listing.item.name}`)
    show(props.api)
  }

  useBindings(() => ({
    bindings: [
      { key: "ctrl+r", desc: "Reload marketplace", group: "Marketplace", cmd: () => void actions.refetch() },
      { key: "ctrl+s", desc: "Open marketplace sources", group: "Marketplace", cmd: () => showSources(props.api) },
    ],
  }))

  return (
    <Show
      when={data()}
      fallback={
        <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
          <text fg={props.api.theme.current.text}>Marketplace</text>
          <text fg={props.api.theme.current.textMuted}>
            {data.error ? errorMessage(data.error) : "Loading catalogs…"}
          </text>
        </box>
      }
    >
      {(value) => (
        <DialogSelect
          title="Marketplace"
          placeholder="Search plugins, skills, agents, commands, MCP servers…"
          options={rows()}
          emptyView={
            <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
              <text fg={props.api.theme.current.textMuted}>
                No marketplace items. Add a catalog with Marketplace: Sources.
              </text>
            </box>
          }
          footer={
            <box flexDirection="column">
              <text fg={props.api.theme.current.textMuted}>
                ctrl+r reload · ctrl+s sources · enter install/update/remove
              </text>
              <Show when={value().catalog.errors.length}>
                <text fg={props.api.theme.current.warning}>
                  {value()
                    .catalog.errors.map((error) => `${error.source.name}: ${error.message}`)
                    .join(" · ")}
                </text>
              </Show>
            </box>
          }
          onSelect={(option) => void apply(option.value)}
        />
      )}
    </Show>
  )
}

function Sources(props: { api: TuiPluginApi }) {
  const [config, actions] = createResource(() => readConfig(props.api))
  const rows = createMemo<DialogSelectOption<string>[]>(() =>
    marketplaceSources(config() ?? {}).map((source) => ({
      title: source.name,
      value: source.id,
      category: source.trust ?? "community",
      description: source.url,
      details: [
        `status: ${source.enabled === false ? "disabled" : "enabled"}`,
        `trust: ${source.trust ?? "community"}`,
      ],
      footer: source.enabled === false ? "disabled" : "enabled",
    })),
  )
  let current: string | undefined

  async function save(next: MarketplaceHostConfig, message: string) {
    try {
      await writeConfig(props.api, next)
      props.api.ui.toast({ variant: "success", message })
      await actions.refetch()
    } catch (error) {
      props.api.ui.toast({ variant: "error", message: errorMessage(error) })
    }
    showSources(props.api)
  }

  async function add() {
    const raw = await prompt(props.api, "Add marketplace catalog", "URL or github:owner/repository")
    if (!raw?.trim()) {
      showSources(props.api)
      return
    }
    try {
      const source = createMarketplaceSource({ url: raw })
      await save(upsertMarketplaceSource(config() ?? {}, source), `Added ${source.name}`)
    } catch (error) {
      props.api.ui.toast({ variant: "error", message: errorMessage(error) })
      showSources(props.api)
    }
  }

  async function remove() {
    const source = marketplaceSources(config() ?? {}).find((item) => item.id === current)
    if (!source || source.id === OFFICIAL_MARKETPLACE_SOURCE.id) return
    if (
      !(await confirm(
        props.api,
        `Remove ${source.name}?`,
        "Installed items remain installed, but updates from this catalog will no longer be discovered.",
      ))
    ) {
      showSources(props.api)
      return
    }
    await save(removeMarketplaceSource(config() ?? {}, source.id), `Removed ${source.name}`)
  }

  useBindings(() => ({
    bindings: [
      { key: "ctrl+a", desc: "Add marketplace source", group: "Marketplace", cmd: () => void add() },
      { key: "ctrl+d", desc: "Remove marketplace source", group: "Marketplace", cmd: () => void remove() },
      { key: "ctrl+b", desc: "Back to marketplace", group: "Marketplace", cmd: () => show(props.api) },
    ],
  }))

  return (
    <Show
      when={config()}
      fallback={
        <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
          <text fg={props.api.theme.current.text}>Marketplace sources</text>
          <text fg={props.api.theme.current.textMuted}>{config.error ? errorMessage(config.error) : "Loading…"}</text>
        </box>
      }
    >
      {(value) => (
        <DialogSelect
          title="Marketplace sources"
          options={rows()}
          onMove={(option) => (current = option.value)}
          footer={
            <text fg={props.api.theme.current.textMuted}>
              ctrl+a add · ctrl+d remove · ctrl+b back · enter enable/disable
            </text>
          }
          onSelect={(option) => {
            const source = marketplaceSources(value()).find((item) => item.id === option.value)
            if (!source) return
            void save(
              toggleMarketplaceSource(value(), source.id, source.enabled === false),
              `${source.enabled === false ? "Enabled" : "Disabled"} ${source.name}`,
            )
          }}
        />
      )}
    </Show>
  )
}

function show(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <View api={api} />)
}

function showSources(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <Sources api={api} />)
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "marketplace.open",
        title: "Marketplace",
        category: "System",
        namespace: "palette",
        run() {
          show(api)
        },
      },
      {
        name: "marketplace.sources",
        title: "Marketplace sources",
        category: "System",
        namespace: "palette",
        run() {
          showSources(api)
        },
      },
    ],
  })
}

const plugin: BuiltinTuiPlugin = { id, tui }
export default plugin
