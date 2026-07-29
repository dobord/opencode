import type { Config } from "@opencode-ai/sdk/v2/client"
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
  type MarketplaceConfiguredTrust,
  type MarketplaceConflict,
  type MarketplaceHostConfig,
  type MarketplaceKind,
  type MarketplaceListing,
  type MarketplaceSource,
  type MarketplaceToggleResult,
} from "@opencode-ai/core/marketplace"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Switch } from "@opencode-ai/ui/switch"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"

const TABS = ["discover", "installed", "updates", "sources"] as const
const KINDS = ["all", "plugin", "skill", "agent", "command", "mcp", "bundle"] as const

type Tab = (typeof TABS)[number]
type KindFilter = (typeof KINDS)[number]
type PendingAction = "install" | "update" | "uninstall"

type Pending = {
  listing: MarketplaceListing
  action: PendingAction
  conflicts: MarketplaceConflict[]
  trustWarning: boolean
}

export function DialogMarketplace() {
  return (
    <Dialog
      size="x-large"
      class="!w-[min(1180px,calc(100vw-32px))] !h-[min(760px,calc(100vh-32px))]"
      title="Marketplace"
      description="Discover and manage OpenCode extensions from trusted catalogs."
    >
      <MarketplacePanel />
    </Dialog>
  )
}

export function MarketplacePanel() {
  const sync = useServerSync()
  const language = useLanguage()
  const [store, setStore] = createStore({
    config: undefined as MarketplaceHostConfig | undefined,
    revision: 0,
    tab: "discover" as Tab,
    kind: "all" as KindFilter,
    query: "",
    selected: undefined as string | undefined,
    busy: false,
    pending: undefined as Pending | undefined,
    sourceURL: "",
    sourceName: "",
    sourceTrust: "community" as MarketplaceConfiguredTrust,
  })

  const config = () => store.config ?? (sync().data.config as Config & MarketplaceHostConfig)
  const [catalog, catalogActions] = createResource(
    () => [store.revision, config()] as const,
    async ([, current]) => loadMarketplace({ config: current }),
  )
  const status = (listing: MarketplaceListing) => marketplaceStatus(config(), listing)
  const updates = createMemo(() => catalog()?.listings.filter((listing) => status(listing) === "update") ?? [])
  const visible = createMemo(() => {
    const query = store.query.trim().toLowerCase()
    return (catalog()?.listings ?? []).filter((listing) => {
      const state = status(listing)
      if (store.tab === "discover" && listing.orphaned) return false
      if (store.tab === "installed" && state === "available") return false
      if (store.tab === "updates" && state !== "update") return false
      if (store.kind !== "all" && listing.item.kind !== store.kind) return false
      if (!query) return true
      return [
        listing.item.name,
        listing.item.description,
        listing.item.publisher?.name,
        listing.catalog.name,
        listing.source.name,
        listing.item.kind,
        ...(listing.item.tags ?? []),
      ]
        .filter((value): value is string => Boolean(value))
        .join(" ")
        .toLowerCase()
        .includes(query)
    })
  })
  const current = createMemo(() => visible().find((listing) => listing.key === store.selected) ?? visible()[0])

  createEffect(() => {
    const listing = current()
    if (listing && store.selected !== listing.key) setStore("selected", listing.key)
  })

  async function save(next: MarketplaceHostConfig, message: string, keys: string[] = []) {
    setStore("busy", true)
    try {
      await sync().updateConfig(next as Config)
      setStore("config", next)
      setStore("revision", (value) => value + 1)
      await Promise.allSettled(
        keys.flatMap((key) =>
          marketplaceEnabledMcpNames(next, key).map((name) => sync().mcp.connect(sync().data.path.directory, name)),
        ),
      )
      showToast({ variant: "success", description: message })
      return true
    } catch (error) {
      showToast({
        variant: "error",
        title: "Marketplace request failed",
        description: error instanceof Error ? error.message : String(error),
      })
      return false
    } finally {
      setStore("busy", false)
    }
  }

  function request(listing: MarketplaceListing) {
    const state = status(listing)
    if (state === "installed") {
      setStore("pending", { listing, action: "uninstall", conflicts: [], trustWarning: false })
      return
    }
    const result = installMarketplaceItem(config(), listing)
    setStore("pending", {
      listing,
      action: state === "update" ? "update" : "install",
      conflicts: result.ok ? [] : result.conflicts,
      trustWarning: !["official", "verified"].includes(listing.source.trust ?? "community"),
    })
  }

  async function confirm() {
    const pending = store.pending
    if (!pending) return
    setStore("pending", undefined)
    if (pending.action === "uninstall") {
      const result = uninstallMarketplaceItem(config(), pending.listing.key)
      if (!(await save(result.config, `Removed ${pending.listing.item.name}`))) {
        setStore("pending", pending)
        return
      }
      if (result.preserved.length) {
        showToast({
          title: "Settings preserved",
          description: `Kept user-modified settings: ${result.preserved.join(", ")}`,
        })
      }
      return
    }
    const result = installMarketplaceItem(config(), pending.listing, { force: pending.conflicts.length > 0 })
    if (!result.ok) {
      setStore("pending", { ...pending, conflicts: result.conflicts })
      return
    }
    if (
      !(await save(
        result.config,
        `${pending.action === "update" ? "Updated" : "Installed"} ${pending.listing.item.name}`,
        [pending.listing.key],
      ))
    ) {
      setStore("pending", pending)
    }
  }

  async function updateAll() {
    const candidates = updates()
    const review = candidates.find((listing) => !["official", "verified"].includes(listing.source.trust ?? "community"))
    if (review) {
      const result = installMarketplaceItem(config(), review)
      setStore("pending", {
        listing: review,
        action: "update",
        conflicts: result.ok ? [] : result.conflicts,
        trustWarning: true,
      })
      return
    }

    let next = config()
    for (const listing of candidates) {
      const result = installMarketplaceItem(next, listing)
      if (!result.ok) {
        setStore("pending", { listing, action: "update", conflicts: result.conflicts, trustWarning: false })
        return
      }
      next = result.config
    }
    if (next === config()) return
    await save(
      next,
      `Updated ${candidates.length} marketplace item${candidates.length === 1 ? "" : "s"}`,
      candidates.map((listing) => listing.key),
    )
  }

  async function addSource() {
    try {
      const source = createMarketplaceSource({
        url: store.sourceURL,
        name: store.sourceName || undefined,
        trust: store.sourceTrust,
      })
      if (await save(upsertMarketplaceSource(config(), source), `Added catalog ${source.name}`)) {
        setStore({ sourceURL: "", sourceName: "", sourceTrust: "community" })
      }
    } catch (error) {
      showToast({
        variant: "error",
        title: "Marketplace request failed",
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function toggle(result: MarketplaceToggleResult, message: string, key: string) {
    if (!result.ok) {
      showToast({
        variant: "error",
        title: language.t("marketplace.toggle.conflict.title"),
        description: language.t("marketplace.toggle.conflict.description", {
          settings: result.conflicts.map((conflict) => conflict.path).join(", "),
        }),
      })
      return
    }
    if (!(await save(result.config, message, [key]))) return
    if (result.preserved.length) {
      showToast({
        title: language.t("marketplace.toggle.preserved.title"),
        description: language.t("marketplace.toggle.preserved.description", {
          settings: result.preserved.join(", "),
        }),
      })
    }
  }

  return (
    <div class="relative flex h-full min-h-0 flex-col gap-3 overflow-hidden p-3">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-16-medium text-text-strong">Marketplace</h2>
          <p class="mt-1 text-12-regular text-text-weak">
            Plugins, skills, agents, commands, MCP servers, and reusable configuration bundles.
          </p>
        </div>
        <div class="flex items-center gap-2 text-12-regular text-text-weak">
          <span>
            {config().marketplace?.installed ? Object.keys(config().marketplace?.installed ?? {}).length : 0} installed
          </span>
          <Show when={updates().length}>
            <button
              type="button"
              class="rounded-md bg-surface-raised-base px-2 py-1 text-text-strong hover:bg-surface-raised-base-hover disabled:opacity-50"
              disabled={store.busy}
              onClick={() => void updateAll()}
            >
              Update all ({updates().length})
            </button>
          </Show>
          <button
            type="button"
            class="rounded-md border border-border-base px-2 py-1 text-text-base hover:bg-surface-raised-base-hover"
            disabled={store.busy}
            onClick={() => void catalogActions.refetch()}
          >
            Reload
          </button>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-1 border-b border-border-weak pb-2">
        <For each={TABS}>
          {(tab) => (
            <button
              type="button"
              class="rounded-md px-2.5 py-1.5 text-12-medium capitalize"
              classList={{
                "bg-surface-raised-base text-text-strong": store.tab === tab,
                "text-text-weak hover:text-text-base": store.tab !== tab,
              }}
              onClick={() => setStore("tab", tab)}
            >
              {tab}
              <Show when={tab === "updates" && updates().length}> ({updates().length})</Show>
            </button>
          )}
        </For>
      </div>

      <Show
        when={store.tab === "sources"}
        fallback={
          <div class="flex min-h-0 flex-1 gap-3 overflow-hidden">
            <div class="flex min-h-0 w-[42%] min-w-72 flex-col overflow-hidden rounded-lg border border-border-weak bg-surface-base">
              <div class="flex gap-2 border-b border-border-weak p-2">
                <input
                  autofocus
                  value={store.query}
                  onInput={(event) => setStore("query", event.currentTarget.value)}
                  placeholder="Search marketplace"
                  class="min-w-0 flex-1 rounded-md border border-border-base bg-background-base px-2.5 py-1.5 text-13-regular text-text-strong outline-none focus:border-border-strong"
                />
                <select
                  value={store.kind}
                  onChange={(event) => setStore("kind", event.currentTarget.value as KindFilter)}
                  class="rounded-md border border-border-base bg-background-base px-2 text-12-regular text-text-base"
                >
                  <For each={KINDS}>{(kind) => <option value={kind}>{kind}</option>}</For>
                </select>
              </div>
              <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
                <Show
                  when={!catalog.loading}
                  fallback={<div class="p-6 text-center text-13-regular text-text-weak">Loading catalogs…</div>}
                >
                  <Show
                    when={visible().length}
                    fallback={<div class="p-6 text-center text-13-regular text-text-weak">No matching items.</div>}
                  >
                    <For each={visible()}>
                      {(listing) => (
                        <button
                          type="button"
                          class="mb-1 flex w-full gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-surface-raised-base-hover"
                          classList={{ "bg-surface-raised-base": current()?.key === listing.key }}
                          onClick={() => setStore("selected", listing.key)}
                        >
                          <PluginIcon listing={listing} size="small" />
                          <div class="min-w-0 flex-1">
                            <div class="flex w-full items-center justify-between gap-2">
                              <span class="truncate text-13-medium text-text-strong">{listing.item.name}</span>
                              <Status value={status(listing)} />
                            </div>
                            <div class="mt-1 line-clamp-2 text-12-regular text-text-weak">
                              {listing.item.description}
                            </div>
                            <div class="mt-1 flex gap-2 text-11-regular text-text-weak">
                              <span class="capitalize">{listing.item.kind}</span>
                              <span>v{listing.item.version}</span>
                              <span class="truncate">{listing.source.name}</span>
                            </div>
                          </div>
                        </button>
                      )}
                    </For>
                  </Show>
                </Show>
              </div>
            </div>

            <div class="min-h-0 min-w-0 flex-1 overflow-y-auto rounded-lg border border-border-weak bg-surface-base p-4">
              <Show
                when={current()}
                fallback={
                  <div class="flex h-full items-center justify-center text-13-regular text-text-weak">
                    Select an item.
                  </div>
                }
              >
                {(listing) => (
                  <Details
                    listing={listing()}
                    config={config()}
                    status={status(listing())}
                    busy={store.busy}
                    action={request}
                    toggle={(result, message) => void toggle(result, message, listing().key)}
                  />
                )}
              </Show>
            </div>
          </div>
        }
      >
        <Sources
          config={config()}
          errors={catalog()?.errors ?? []}
          busy={store.busy}
          sourceURL={store.sourceURL}
          sourceName={store.sourceName}
          sourceTrust={store.sourceTrust}
          setURL={(value) => setStore("sourceURL", value)}
          setName={(value) => setStore("sourceName", value)}
          setTrust={(value) => setStore("sourceTrust", value)}
          add={() => void addSource()}
          toggle={(source) =>
            void save(
              toggleMarketplaceSource(config(), source.id, source.enabled === false),
              `${source.enabled === false ? "Enabled" : "Disabled"} ${source.name}`,
            )
          }
          remove={(source) => void save(removeMarketplaceSource(config(), source.id), `Removed catalog ${source.name}`)}
        />
      </Show>

      <Show when={catalog()?.errors.length}>
        <div class="rounded-md border border-border-warning bg-surface-base px-3 py-2 text-12-regular text-text-weak">
          <For each={catalog()?.errors}>
            {(error) => (
              <div>
                {error.source.name}: {error.message}
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={store.pending}>
        {(pending) => (
          <div class="absolute inset-0 z-10 flex items-center justify-center bg-background-base/80 p-4">
            <div class="w-full max-w-lg rounded-xl border border-border-base bg-surface-base p-4 shadow-lg">
              <h3 class="text-15-medium text-text-strong capitalize">
                {pending().action} {pending().listing.item.name}
              </h3>
              <p class="mt-2 text-12-regular text-text-weak">
                {pending().action === "uninstall"
                  ? "OpenCode will remove only settings that still match the installed receipt. User-edited values are preserved."
                  : marketplacePlanSummary(pending().listing.item.install)}
              </p>
              <Show when={pending().trustWarning}>
                <div class="mt-3 rounded-md border border-border-warning px-3 py-2 text-12-regular text-text-base">
                  This catalog is marked {pending().listing.source.trust ?? "community"}. Review its publisher and
                  repository before installing.
                </div>
              </Show>
              <Show when={pending().conflicts.length}>
                <div class="mt-3 rounded-md border border-border-warning px-3 py-2 text-12-regular text-text-base">
                  <div class="font-medium">These settings will be replaced:</div>
                  <For each={pending().conflicts}>
                    {(conflict) => <div class="mt-1 font-mono">{conflict.path}</div>}
                  </For>
                </div>
              </Show>
              <Show when={pending().action !== "uninstall" && marketplacePermissions(pending().listing.item).length}>
                <div class="mt-3 text-12-regular text-text-weak">
                  <div class="font-medium text-text-base">Requested capabilities</div>
                  <For each={marketplacePermissions(pending().listing.item)}>
                    {(permission) => <div class="mt-1">• {permission}</div>}
                  </For>
                </div>
              </Show>
              <div class="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  class="rounded-md px-3 py-1.5 text-12-medium text-text-base hover:bg-surface-raised-base-hover"
                  onClick={() => setStore("pending", undefined)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="rounded-md bg-surface-raised-base px-3 py-1.5 text-12-medium text-text-strong hover:bg-surface-raised-base-hover"
                  disabled={store.busy}
                  onClick={() => void confirm()}
                >
                  Confirm
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}

function Status(props: { value: ReturnType<typeof marketplaceStatus> }) {
  return (
    <span
      class="shrink-0 rounded px-1.5 py-0.5 text-10-medium uppercase"
      classList={{
        "bg-surface-raised-base text-text-weak": props.value === "available",
        "bg-surface-raised-base text-text-strong": props.value === "installed",
        "bg-surface-raised-base text-text-base": props.value === "update",
      }}
    >
      {props.value}
    </span>
  )
}

function PluginIcon(props: { listing: MarketplaceListing; size: "small" | "large" }) {
  const theme = useTheme()
  const [failed, setFailed] = createSignal(false)
  const source = () =>
    theme.mode() === "dark"
      ? (props.listing.item.icon?.["src-dark"] ?? props.listing.item.icon?.["src-light"])
      : props.listing.item.icon?.["src-light"]
  const initials = () =>
    props.listing.item.name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase()

  createEffect(() => {
    source()
    setFailed(false)
  })

  return (
    <div
      class="flex shrink-0 items-center justify-center overflow-hidden rounded-xl text-12-medium text-white shadow-sm"
      classList={{
        "size-10": props.size === "small",
        "size-16 text-18-medium": props.size === "large",
      }}
      style={{ "background-color": props.listing.item.brand_color ?? "#5C6470" }}
    >
      <Show when={source() && !failed()} fallback={<span aria-hidden="true">{initials()}</span>}>
        <img
          src={source()}
          alt=""
          loading="lazy"
          referrerpolicy="no-referrer"
          class="size-full object-cover"
          onError={() => setFailed(true)}
        />
      </Show>
    </div>
  )
}

function Details(props: {
  listing: MarketplaceListing
  config: MarketplaceHostConfig
  status: ReturnType<typeof marketplaceStatus>
  busy: boolean
  action: (listing: MarketplaceListing) => void
  toggle: (result: MarketplaceToggleResult, message: string) => void
}) {
  const language = useLanguage()
  const permissions = () => marketplacePermissions(props.listing.item)
  const installed = () => props.config.marketplace?.installed?.[props.listing.key]
  const enabled = () => marketplaceItemEnabled(props.config, props.listing.key)
  const skills = () => marketplaceSkillComponents(installed()?.plan ?? props.listing.item.install)
  const mcp = () => Object.keys(installed()?.plan.mcp ?? props.listing.item.install.mcp ?? {})
  const stateLabel = (value: boolean) =>
    language.t(value ? "marketplace.component.enabled" : "marketplace.component.disabled")

  return (
    <div class="flex min-h-full flex-col">
      <div class="flex items-start justify-between gap-4">
        <div class="flex min-w-0 items-start gap-3">
          <PluginIcon listing={props.listing} size="large" />
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <h3 class="text-18-medium text-text-strong">{props.listing.item.name}</h3>
              <Status value={props.status} />
            </div>
            <div class="mt-1 text-12-regular text-text-weak">
              {props.listing.item.publisher?.name ?? props.listing.catalog.publisher?.name ?? "Unknown publisher"} · v
              {props.listing.item.version} · {props.listing.source.name}
            </div>
          </div>
        </div>
        <button
          type="button"
          disabled={props.busy}
          class="shrink-0 rounded-md bg-surface-raised-base px-3 py-1.5 text-12-medium text-text-strong hover:bg-surface-raised-base-hover disabled:opacity-50"
          onClick={() => props.action(props.listing)}
        >
          {props.status === "available" ? "Install" : props.status === "update" ? "Update" : "Uninstall"}
        </button>
      </div>
      <Show when={props.listing.orphaned}>
        <div class="mt-4 rounded-md border border-border-warning px-3 py-2 text-12-regular text-text-base">
          This item is still installed, but its catalog is unavailable or no longer lists it. You can safely uninstall
          it from this receipt-backed entry.
        </div>
      </Show>
      <p class="mt-4 whitespace-pre-wrap text-13-regular leading-5 text-text-base">{props.listing.item.description}</p>
      <Show when={installed()}>
        <div class="mt-5 rounded-lg border border-border-weak">
          <div class="flex items-center justify-between gap-4 p-3">
            <div>
              <div class="text-13-medium text-text-strong">{language.t("marketplace.component.plugin.title")}</div>
              <div class="mt-0.5 text-11-regular text-text-weak">
                {language.t("marketplace.component.plugin.description")}
              </div>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-11-regular text-text-weak">{stateLabel(enabled())}</span>
              <Switch
                checked={enabled()}
                disabled={props.busy}
                aria-label={language.t("marketplace.component.plugin.toggle", { name: props.listing.item.name })}
                onChange={(checked) =>
                  props.toggle(
                    setMarketplaceItemEnabled(props.config, props.listing.key, checked),
                    language.t(
                      checked ? "marketplace.component.plugin.enabled" : "marketplace.component.plugin.disabled",
                      { name: props.listing.item.name },
                    ),
                  )
                }
              />
            </div>
          </div>

          <Show when={skills().length}>
            <div class="border-t border-border-weak p-3">
              <div class="text-12-medium text-text-strong">{language.t("marketplace.component.skills.title")}</div>
              <div class="mt-0.5 text-11-regular text-text-weak">
                {language.t("marketplace.component.skills.description")}
              </div>
              <div class="mt-2 grid gap-1">
                <For each={skills()}>
                  {(skill) => {
                    const checked = () => marketplaceSkillEnabled(props.config, props.listing.key, skill.id)
                    return (
                      <div class="flex items-center justify-between gap-3 rounded-md bg-surface-raised-base px-2.5 py-2">
                        <div class="min-w-0">
                          <div class="truncate text-12-medium text-text-base">{skill.name}</div>
                          <Show when={skill.description}>
                            <div class="mt-0.5 line-clamp-2 text-11-regular text-text-weak">{skill.description}</div>
                          </Show>
                        </div>
                        <div class="flex shrink-0 items-center gap-2">
                          <span class="text-11-regular text-text-weak">{stateLabel(checked())}</span>
                          <Switch
                            checked={checked()}
                            disabled={props.busy || !enabled()}
                            aria-label={language.t("marketplace.component.skill.toggle", { name: skill.name })}
                            onChange={(value) =>
                              props.toggle(
                                setMarketplaceSkillEnabled(props.config, props.listing.key, skill.id, value),
                                language.t(
                                  value
                                    ? "marketplace.component.skill.enabled"
                                    : "marketplace.component.skill.disabled",
                                  { name: skill.name },
                                ),
                              )
                            }
                          />
                        </div>
                      </div>
                    )
                  }}
                </For>
              </div>
            </div>
          </Show>

          <Show when={mcp().length}>
            <div class="border-t border-border-weak p-3">
              <div class="text-12-medium text-text-strong">{language.t("marketplace.component.mcp.title")}</div>
              <div class="mt-0.5 text-11-regular text-text-weak">
                {language.t("marketplace.component.mcp.description")}
              </div>
              <div class="mt-2 grid gap-1">
                <For each={mcp()}>
                  {(name) => {
                    const checked = () => marketplaceMcpEnabled(props.config, props.listing.key, name)
                    return (
                      <div class="flex items-center justify-between gap-3 rounded-md bg-surface-raised-base px-2.5 py-2">
                        <span class="min-w-0 truncate text-12-medium text-text-base">{name}</span>
                        <div class="flex shrink-0 items-center gap-2">
                          <span class="text-11-regular text-text-weak">{stateLabel(checked())}</span>
                          <Switch
                            checked={checked()}
                            disabled={props.busy || !enabled()}
                            aria-label={language.t("marketplace.component.mcp.toggle", { name })}
                            onChange={(value) =>
                              props.toggle(
                                setMarketplaceMcpEnabled(props.config, props.listing.key, name, value),
                                language.t(
                                  value ? "marketplace.component.mcp.enabled" : "marketplace.component.mcp.disabled",
                                  { name },
                                ),
                              )
                            }
                          />
                        </div>
                      </div>
                    )
                  }}
                </For>
              </div>
            </div>
          </Show>
        </div>
      </Show>
      <div class="mt-4 grid grid-cols-2 gap-3 text-12-regular">
        <Meta label="Type" value={props.listing.item.kind} />
        <Meta label="Trust" value={props.listing.source.trust ?? "community"} />
        <Meta label="Changes" value={marketplacePlanSummary(props.listing.item.install)} />
        <Meta label="License" value={props.listing.item.license ?? "Not specified"} />
      </div>
      <Show when={permissions().length}>
        <div class="mt-5">
          <h4 class="text-12-medium text-text-strong">Capabilities</h4>
          <For each={permissions()}>
            {(permission) => <div class="mt-1.5 text-12-regular text-text-weak">• {permission}</div>}
          </For>
        </div>
      </Show>
      <Show when={props.listing.item.setup?.length}>
        <div class="mt-5">
          <h4 class="text-12-medium text-text-strong">After installation</h4>
          <For each={props.listing.item.setup}>
            {(step) => <div class="mt-1.5 text-12-regular text-text-weak">• {step}</div>}
          </For>
        </div>
      </Show>
      <div class="mt-auto flex flex-wrap gap-3 pt-6 text-12-regular text-text-weak">
        <Show when={props.listing.item.homepage}>
          <a href={props.listing.item.homepage} target="_blank" rel="noreferrer" class="hover:text-text-base">
            Homepage
          </a>
        </Show>
        <Show when={props.listing.item.repository}>
          <a href={props.listing.item.repository} target="_blank" rel="noreferrer" class="hover:text-text-base">
            Repository
          </a>
        </Show>
        <Show when={props.listing.catalog.homepage}>
          <a href={props.listing.catalog.homepage} target="_blank" rel="noreferrer" class="hover:text-text-base">
            Catalog
          </a>
        </Show>
      </div>
    </div>
  )
}

function Meta(props: { label: string; value: string }) {
  return (
    <div>
      <div class="text-text-weak">{props.label}</div>
      <div class="mt-0.5 capitalize text-text-base">{props.value}</div>
    </div>
  )
}

function Sources(props: {
  config: MarketplaceHostConfig
  errors: { source: MarketplaceSource; message: string }[]
  busy: boolean
  sourceURL: string
  sourceName: string
  sourceTrust: MarketplaceConfiguredTrust
  setURL: (value: string) => void
  setName: (value: string) => void
  setTrust: (value: MarketplaceConfiguredTrust) => void
  add: () => void
  toggle: (source: MarketplaceSource) => void
  remove: (source: MarketplaceSource) => void
}) {
  return (
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="grid gap-2">
        <For each={marketplaceSources(props.config)}>
          {(source) => {
            const error = () => props.errors.find((item) => item.source.id === source.id)
            return (
              <div class="flex items-start justify-between gap-4 rounded-lg border border-border-weak bg-surface-base p-3">
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="text-13-medium text-text-strong">{source.name}</span>
                    <span class="rounded bg-surface-raised-base px-1.5 py-0.5 text-10-medium uppercase text-text-weak">
                      {source.trust ?? "community"}
                    </span>
                    <span class="text-11-regular text-text-weak">
                      {source.enabled === false ? "disabled" : "enabled"}
                    </span>
                  </div>
                  <div class="mt-1 truncate font-mono text-11-regular text-text-weak">{source.url}</div>
                  <Show when={error()}>
                    {(value) => <div class="mt-1 text-11-regular text-text-base">{value().message}</div>}
                  </Show>
                </div>
                <div class="flex shrink-0 gap-2">
                  <button
                    type="button"
                    disabled={props.busy}
                    class="rounded-md border border-border-base px-2 py-1 text-11-medium text-text-base hover:bg-surface-raised-base-hover"
                    onClick={() => props.toggle(source)}
                  >
                    {source.enabled === false ? "Enable" : "Disable"}
                  </button>
                  <Show when={source.id !== OFFICIAL_MARKETPLACE_SOURCE.id}>
                    <button
                      type="button"
                      disabled={props.busy}
                      class="rounded-md border border-border-base px-2 py-1 text-11-medium text-text-base hover:bg-surface-raised-base-hover"
                      onClick={() => props.remove(source)}
                    >
                      Remove
                    </button>
                  </Show>
                </div>
              </div>
            )
          }}
        </For>
      </div>
      <div class="mt-4 rounded-lg border border-border-weak bg-surface-base p-3">
        <h3 class="text-13-medium text-text-strong">Add catalog</h3>
        <p class="mt-1 text-12-regular text-text-weak">
          Use an HTTPS JSON URL, GitHub repository URL, or github:owner/repository shorthand. Official and verified
          trust is reserved for catalogs distributed by OpenCode.
        </p>
        <div class="mt-3 grid grid-cols-[1fr_180px] gap-2">
          <input
            value={props.sourceURL}
            onInput={(event) => props.setURL(event.currentTarget.value)}
            placeholder="https://…/.opencode/marketplace.json"
            class="rounded-md border border-border-base bg-background-base px-2.5 py-1.5 text-13-regular text-text-strong outline-none focus:border-border-strong"
          />
          <select
            value={props.sourceTrust}
            onChange={(event) => props.setTrust(event.currentTarget.value as MarketplaceConfiguredTrust)}
            class="rounded-md border border-border-base bg-background-base px-2 text-12-regular text-text-base"
          >
            <option value="community">Community</option>
            <option value="private">Private</option>
          </select>
          <input
            value={props.sourceName}
            onInput={(event) => props.setName(event.currentTarget.value)}
            placeholder="Optional display name"
            class="rounded-md border border-border-base bg-background-base px-2.5 py-1.5 text-13-regular text-text-strong outline-none focus:border-border-strong"
          />
          <button
            type="button"
            disabled={props.busy || !props.sourceURL.trim()}
            onClick={props.add}
            class="rounded-md bg-surface-raised-base px-3 py-1.5 text-12-medium text-text-strong hover:bg-surface-raised-base-hover disabled:opacity-50"
          >
            Add catalog
          </button>
        </div>
      </div>
    </div>
  )
}
