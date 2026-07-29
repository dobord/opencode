import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Config } from "@opencode-ai/sdk/v2"
import {
  OFFICIAL_MARKETPLACE_SOURCE,
  createMarketplaceSource,
  installMarketplaceItem,
  loadMarketplace,
  marketplaceEnabledMcpNames,
  marketplaceItemEnabled,
  marketplaceMcpEnabled,
  marketplacePermissions,
  marketplacePlanSummary,
  marketplaceSkillComponents,
  marketplaceSkillEnabled,
  marketplaceSources,
  marketplaceStatus,
  removeMarketplaceSource,
  setMarketplaceItemEnabled,
  setMarketplaceMcpEnabled,
  setMarketplaceSkillEnabled,
  toggleMarketplaceSource,
  uninstallMarketplaceItem,
  upsertMarketplaceSource,
  type MarketplaceHostConfig,
  type MarketplaceListing,
  type MarketplaceToggleResult,
} from "@opencode-ai/core/marketplace"
import { createMemo, createResource } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { useBindings } from "../../keymap"
import { errorMessage } from "../../util/error"
import type { BuiltinTuiPlugin } from "../builtins"

const id = "internal:marketplace"

async function readConfig(api: TuiPluginApi) {
  const result = await api.client.global.config.get()
  if (result.error) throw new Error(errorMessage(result.error))
  return (result.data ?? {}) as Config & MarketplaceHostConfig
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

function toggleStatus(api: TuiPluginApi, enabled: boolean) {
  return (
    <span style={{ fg: enabled ? api.theme.current.success : api.theme.current.textMuted }}>
      {enabled ? "enabled" : "disabled"}
    </span>
  )
}

async function saveToggle(
  api: TuiPluginApi,
  result: MarketplaceToggleResult,
  message: string,
  key: string,
  next: () => void,
) {
  if (!result.ok) {
    api.ui.toast({
      variant: "error",
      message: `Conflicting settings: ${result.conflicts.map((conflict) => conflict.path).join(", ")}`,
    })
    next()
    return
  }
  try {
    await writeConfig(api, result.config)
    await Promise.allSettled(
      marketplaceEnabledMcpNames(result.config, key).map((name) => api.client.mcp.connect({ name })),
    )
    api.ui.toast({ variant: "success", message })
    if (result.preserved.length) {
      api.ui.toast({ variant: "warning", message: `Kept modified settings: ${result.preserved.join(", ")}` })
    }
  } catch (error) {
    api.ui.toast({ variant: "error", message: errorMessage(error) })
  }
  next()
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
  let current: string | undefined

  async function save(next: MarketplaceHostConfig, message: string, key?: string) {
    try {
      await writeConfig(props.api, next)
      if (key) {
        await Promise.allSettled(
          marketplaceEnabledMcpNames(next, key).map((name) => props.api.client.mcp.connect({ name })),
        )
      }
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
      showComponents(props.api, listing)
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
    await save(result.config, `${status === "update" ? "Updated" : "Installed"} ${listing.item.name}`, listing.key)
    show(props.api)
  }

  useBindings(() => ({
    bindings: [
      { key: "ctrl+r", desc: "Reload marketplace", group: "Marketplace", cmd: () => void actions.refetch() },
      { key: "ctrl+s", desc: "Open marketplace sources", group: "Marketplace", cmd: () => showSources(props.api) },
      {
        key: "space",
        desc: "Enable or disable installed plugin",
        group: "Marketplace",
        cmd: () => {
          const listing = current ? selected(current) : undefined
          const config = data()?.config
          if (!listing || !config || marketplaceStatus(config, listing) === "available") return
          const enabled = !marketplaceItemEnabled(config, listing.key)
          void saveToggle(
            props.api,
            setMarketplaceItemEnabled(config, listing.key, enabled),
            `${enabled ? "Enabled" : "Disabled"} ${listing.item.name}`,
            listing.key,
            () => show(props.api),
          )
        },
      },
    ],
  }))

  return (
    <DialogSelect
      title="Marketplace"
      placeholder="Search plugins, skills, agents, commands, MCP servers…"
      options={rows()}
      onMove={(option) => (current = option.value)}
      emptyView={
        <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
          <text fg={props.api.theme.current.textMuted}>
            {data.loading
              ? "Loading catalogs…"
              : data.error
                ? errorMessage(data.error)
                : "No marketplace items. Add a catalog with Marketplace: Sources."}
          </text>
        </box>
      }
      footer={
        <box flexDirection="column">
          <text fg={props.api.theme.current.textMuted}>
            ctrl+r reload · ctrl+s sources · space enable/disable · enter install/update/manage
          </text>
          {data()?.catalog.errors.length ? (
            <text fg={props.api.theme.current.warning}>
              {data()!
                .catalog.errors.map((error) => `${error.source.name}: ${error.message}`)
                .join(" · ")}
            </text>
          ) : null}
        </box>
      }
      onSelect={(option) => void apply(option.value)}
    />
  )
}

function Components(props: { api: TuiPluginApi; listing: MarketplaceListing }) {
  const [config] = createResource(() => readConfig(props.api))
  const installed = () => config()?.marketplace?.installed?.[props.listing.key]
  const rows = createMemo<DialogSelectOption<string>[]>(() => {
    const cfg = config()
    if (!cfg) return []
    const state = installed()
    if (!state) return []
    const pluginEnabled = marketplaceItemEnabled(cfg, props.listing.key)
    return [
      {
        title: props.listing.item.name,
        value: "plugin",
        category: "Plugin",
        description: "Turn every capability in this plugin on or off.",
        details: [
          `status: ${pluginEnabled ? "enabled" : "disabled"}`,
          "Enabling starts every MCP server that was not explicitly disabled.",
        ],
        footer: toggleStatus(props.api, pluginEnabled),
      },
      ...marketplaceSkillComponents(state.plan).map((skill) => {
        const enabled = marketplaceSkillEnabled(cfg, props.listing.key, skill.id)
        return {
          title: skill.name,
          value: `skill:${skill.id}`,
          category: "Skills",
          description: skill.description ?? skill.path ?? skill.url,
          details: [`status: ${enabled ? "enabled" : "disabled"}`],
          footer: toggleStatus(props.api, enabled),
        }
      }),
      ...Object.keys(state.plan.mcp ?? {}).map((name) => {
        const enabled = marketplaceMcpEnabled(cfg, props.listing.key, name)
        return {
          title: name,
          value: `mcp:${name}`,
          category: "MCP servers",
          description: enabled
            ? "Starts automatically when the plugin is enabled."
            : "Explicitly disabled; enabling the plugin will not start it.",
          details: [`status: ${enabled ? "enabled" : "disabled"}`],
          footer: toggleStatus(props.api, enabled),
        }
      }),
    ]
  })

  async function remove() {
    if (
      !(await confirm(
        props.api,
        `Remove ${props.listing.item.name}?`,
        "Only unchanged settings from its installation receipt will be removed.",
      ))
    ) {
      showComponents(props.api, props.listing)
      return
    }
    const cfg = config()
    if (!cfg) return
    const result = uninstallMarketplaceItem(cfg, props.listing.key)
    try {
      await writeConfig(props.api, result.config)
      props.api.ui.toast({ variant: "success", message: `Removed ${props.listing.item.name}` })
      if (result.preserved.length) {
        props.api.ui.toast({ variant: "warning", message: `Kept modified settings: ${result.preserved.join(", ")}` })
      }
    } catch (error) {
      props.api.ui.toast({ variant: "error", message: errorMessage(error) })
    }
    show(props.api)
  }

  useBindings(() => ({
    bindings: [
      { key: "ctrl+b", desc: "Back to marketplace", group: "Marketplace", cmd: () => show(props.api) },
      { key: "ctrl+d", desc: "Uninstall plugin", group: "Marketplace", cmd: () => void remove() },
    ],
  }))

  return (
    <DialogSelect
      title={`${props.listing.item.name} components`}
      options={rows()}
      footer={<text fg={props.api.theme.current.textMuted}>enter toggle · ctrl+d uninstall · ctrl+b back</text>}
      onSelect={(option) => {
        const cfg = config()
        if (!cfg) return
        const state = installed()
        if (!state) return
        if (option.value === "plugin") {
          const enabled = !marketplaceItemEnabled(cfg, props.listing.key)
          void saveToggle(
            props.api,
            setMarketplaceItemEnabled(cfg, props.listing.key, enabled),
            `${enabled ? "Enabled" : "Disabled"} ${props.listing.item.name}`,
            props.listing.key,
            () => showComponents(props.api, props.listing),
          )
          return
        }
        if (!marketplaceItemEnabled(cfg, props.listing.key)) {
          props.api.ui.toast({ variant: "warning", message: "Enable the plugin before changing its components" })
          showComponents(props.api, props.listing)
          return
        }
        if (option.value.startsWith("skill:")) {
          const id = option.value.slice("skill:".length)
          const enabled = !marketplaceSkillEnabled(cfg, props.listing.key, id)
          void saveToggle(
            props.api,
            setMarketplaceSkillEnabled(cfg, props.listing.key, id, enabled),
            `${enabled ? "Enabled" : "Disabled"} skill ${option.title}`,
            props.listing.key,
            () => showComponents(props.api, props.listing),
          )
          return
        }
        const name = option.value.slice("mcp:".length)
        const enabled = !marketplaceMcpEnabled(cfg, props.listing.key, name)
        void saveToggle(
          props.api,
          setMarketplaceMcpEnabled(cfg, props.listing.key, name, enabled),
          `${enabled ? "Enabled" : "Disabled"} MCP server ${name}`,
          props.listing.key,
          () => showComponents(props.api, props.listing),
        )
      }}
    />
  )
}

function Sources(props: { api: TuiPluginApi }) {
  const [config] = createResource(() => readConfig(props.api))
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
      const cfg = config()
      if (!cfg) return
      await save(upsertMarketplaceSource(cfg, source), `Added ${source.name}`)
    } catch (error) {
      props.api.ui.toast({ variant: "error", message: errorMessage(error) })
      showSources(props.api)
    }
  }

  async function remove() {
    const cfg = config()
    if (!cfg) return
    const source = marketplaceSources(cfg).find((item) => item.id === current)
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
    await save(removeMarketplaceSource(cfg, source.id), `Removed ${source.name}`)
  }

  useBindings(() => ({
    bindings: [
      { key: "ctrl+a", desc: "Add marketplace source", group: "Marketplace", cmd: () => void add() },
      { key: "ctrl+d", desc: "Remove marketplace source", group: "Marketplace", cmd: () => void remove() },
      { key: "ctrl+b", desc: "Back to marketplace", group: "Marketplace", cmd: () => show(props.api) },
    ],
  }))

  return (
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
        const cfg = config()
        if (!cfg) return
        const source = marketplaceSources(cfg).find((item) => item.id === option.value)
        if (!source) return
        void save(
          toggleMarketplaceSource(cfg, source.id, source.enabled === false),
          `${source.enabled === false ? "Enabled" : "Disabled"} ${source.name}`,
        )
      }}
    />
  )
}

function show(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <View api={api} />)
}

function showSources(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <Sources api={api} />)
}

function showComponents(api: TuiPluginApi, listing: MarketplaceListing) {
  api.ui.dialog.replace(() => <Components api={api} listing={listing} />)
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
          setTimeout(() => show(api), 0)
        },
      },
      {
        name: "marketplace.sources",
        title: "Marketplace sources",
        category: "System",
        namespace: "palette",
        run() {
          setTimeout(() => showSources(api), 0)
        },
      },
    ],
  })
}

const plugin: BuiltinTuiPlugin = { id, tui }
export default plugin
