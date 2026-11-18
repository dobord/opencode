import { Button } from "@opencode/ui/button"
import { Dialog, DialogHeader, DialogTitle } from "@opencode/ui/dialog"
import { Loader } from "@opencode/ui/loader"
import { Switch } from "@opencode/ui/switch"
import { TextField } from "@opencode/ui/text-field"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useData } from "@/runtime/server/current"
import { useServer } from "@/runtime/server/current"
import { BackgroundMarketplacePanel } from "./background-panel"
import { MarketplaceLogo } from "./logo"
import { formatServerError } from "@/runtime/server/errors"
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { busy, transition, type Event, type Listing, type State, type View } from "./machine"

export function DialogMarketplace() {
  const language = useLanguage()
  return (
    <Dialog size="large">
      <DialogHeader>
        <DialogTitle>{language.t("marketplace.title")}</DialogTitle>
      </DialogHeader>
      <MarketplacePanel />
    </Dialog>
  )
}

export function MarketplacePanel() {
  const controller = useServer().ctx.marketplace
  const data = useData()
  onMount(() => {
    if (controller.state().status === "idle") void controller.load(data.location.default())
  })
  return (
    <Show when={controller.state().status !== "unavailable"} fallback={<LegacyMarketplacePanel />}>
      <BackgroundMarketplacePanel />
    </Show>
  )
}

function LegacyMarketplacePanel() {
  const language = useLanguage()
  const sdk = useServerSDK()
  const data = useData()
  const client = sdk.api.experimental.marketplace
  const location = () => data.location.default()
  const [state, setState] = createSignal<State>({ status: "idle", attempt: 0 })
  const [form, setForm] = createStore({ tab: "discover", query: "", url: "", name: "" })
  const lifetime = new AbortController()
  onCleanup(() => {
    lifetime.abort()
    dispatch({ type: "disposed" })
  })
  const dispatch = (event: Event) => setState((current) => transition(current, event))
  const view = () => state().view
  const revision = () => view()?.state.revision ?? 0
  const disabled = () => busy(state())
  const listings = () =>
    (view()?.listings ?? []).filter(
      (listing) =>
        (form.tab === "discover"
          ? !listing.orphaned
          : form.tab === "updates"
            ? listing.status === "update"
            : listing.status !== "available") &&
        `${listing.item.name} ${listing.item.description} ${listing.item.kind}`
          .toLowerCase()
          .includes(form.query.toLowerCase()),
    )

  async function run(task: (signal: AbortSignal) => Promise<View>, timeout = 60_000) {
    if (disabled()) return
    dispatch({ type: "start" })
    const attempt = state().attempt
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeout)])
    try {
      dispatch({ type: "loaded", attempt, view: await task(signal) })
    } catch (error) {
      dispatch({ type: "failed", attempt, error: formatServerError(error, language.t) })
    }
  }

  const refresh = () => run((signal) => client.refresh({ location: location() }, { signal }))
  onMount(() => void refresh())

  async function plan(listing: Listing) {
    if (disabled()) return
    dispatch({ type: "start" })
    const attempt = state().attempt
    try {
      const result = await client.plan(
        { location: location(), key: listing.key },
        {
          signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(60_000)]),
        },
      )
      if (!result.ok) throw new Error(result.message)
      dispatch({ type: "planned", attempt, listing, plan: result })
    } catch (error) {
      dispatch({ type: "failed", attempt, error: formatServerError(error, language.t) })
    }
  }

  const mutation = async (request: ReturnType<typeof client.install>) => {
    const result = await request
    if (!result.ok) throw new Error(result.message)
    return result.view
  }

  const install = (listing: Listing) =>
    // A cold repository download can take several minutes; do not abort the
    // UI request while the server is still downloading it successfully.
    run(
      (signal) =>
        mutation(
          client.install(
            {
              location: location(),
              key: listing.key,
              expected_revision: revision(),
              force: true,
              accept_untrusted: true,
            },
            { signal },
          ),
        ),
      360_000,
    )

  return (
    <div class="flex flex-col gap-4 p-4 min-h-0 overflow-y-auto" data-scrollable>
      <div class="flex flex-wrap gap-2">
        <For each={["discover", "installed", "updates", "sources"] as const}>
          {(tab) => (
            <Button variant={form.tab === tab ? "neutral" : "ghost-muted"} onClick={() => setForm("tab", tab)}>
              {language.t(`marketplace.tab.${tab}`)}
            </Button>
          )}
        </For>
        <Button disabled={disabled()} onClick={() => void refresh()}>
          {language.t("marketplace.refresh")}
        </Button>
        <Button
          disabled={disabled()}
          onClick={() =>
            void run(async (signal) => {
              await client.cachePrune({ location: location(), max_age_days: 30 }, { signal })
              return client.get({ location: location() }, { signal })
            })
          }
        >
          {language.t("marketplace.prune")}
        </Button>
        <Button
          disabled={disabled()}
          onClick={() =>
            void run(async (signal) => {
              const result = await client.profileExport({ location: location() }, { signal })
              const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }))
              const link = document.createElement("a")
              link.href = url
              link.download = "marketplace-profile.json"
              link.click()
              URL.revokeObjectURL(url)
              return view() ?? (await client.get({ location: location() }, { signal }))
            })
          }
        >
          {language.t("marketplace.export")}
        </Button>
      </div>
      <Show when={disabled()}>
        <Loader />
      </Show>
      <Show when={state().status === "failed" && state()}>
        {(current) => (
          <div role="alert">
            {(() => {
              const value = current()
              return value.status === "failed" ? value.error : ""
            })()}
          </div>
        )}
      </Show>
      <For each={view()?.errors}>
        {(error) => (
          <div role="alert">
            {error.source.name}: {error.message}
          </div>
        )}
      </For>
      <Show when={state().status === "confirming" ? state() : undefined}>
        {(current) => {
          const confirmation = () => {
            const value = current()
            return value.status === "confirming" ? value : undefined
          }
          return (
            <section class="flex flex-col gap-2 border rounded p-3">
              <strong>{confirmation()?.listing.item.name}</strong>
              <p>{confirmation()?.plan.summary}</p>
              <Show when={confirmation()?.plan.trust_warning}>
                <p>{language.t("marketplace.trustWarning")}</p>
              </Show>
              <For each={confirmation()?.plan.conflicts}>{(conflict) => <p>{conflict.path}</p>}</For>
              <For each={confirmation()?.plan.permissions}>{(permission) => <code>{permission}</code>}</For>
              <div class="flex gap-2">
                <Button
                  onClick={() => {
                    const value = confirmation()
                    if (value) void install(value.listing)
                  }}
                >
                  {language.t("marketplace.confirm")}
                </Button>
                <Button variant="ghost-muted" onClick={() => dispatch({ type: "cancel" })}>
                  {language.t("common.cancel")}
                </Button>
              </div>
            </section>
          )
        }}
      </Show>
      <Show
        when={form.tab !== "sources"}
        fallback={
          <>
            <TextField
              value={form.url}
              onChange={(value) => setForm("url", value)}
              placeholder={language.t("marketplace.source.url")}
            />
            <TextField
              value={form.name}
              onChange={(value) => setForm("name", value)}
              placeholder={language.t("marketplace.source.name")}
            />
            <Button
              disabled={disabled() || !form.url.trim()}
              onClick={() =>
                void run((signal) =>
                  mutation(
                    client.sourceAdd(
                      {
                        location: location(),
                        url: form.url,
                        name: form.name || undefined,
                        expected_revision: revision(),
                        trust: "community",
                      },
                      { signal },
                    ),
                  ),
                )
              }
            >
              {language.t("marketplace.source.add")}
            </Button>
            <For each={view()?.state.sources}>
              {(source) => (
                <div class="flex items-center gap-2">
                  <span class="flex-1 min-w-0">
                    <bdi>{source.name}</bdi>
                    <br />
                    <bdi dir="ltr">
                      <code class="break-all">{source.reference ?? source.url}</code>
                    </bdi>
                  </span>
                  <Switch
                    checked={source.enabled !== false}
                    disabled={disabled()}
                    onChange={(enabled) =>
                      void run((signal) =>
                        mutation(
                          client.sourceToggle(
                            {
                              location: location(),
                              id: source.id,
                              expected_revision: revision(),
                              enabled,
                            },
                            { signal },
                          ),
                        ),
                      )
                    }
                  >
                    {source.name}
                  </Switch>
                  <Button
                    disabled={disabled()}
                    onClick={() =>
                      void run((signal) =>
                        mutation(
                          client.sourceRemove(
                            {
                              location: location(),
                              id: source.id,
                              expected_revision: revision(),
                            },
                            { signal },
                          ),
                        ),
                      )
                    }
                  >
                    {language.t("marketplace.remove")}
                  </Button>
                </div>
              )}
            </For>
          </>
        }
      >
        <TextField
          value={form.query}
          onChange={(value) => setForm("query", value)}
          placeholder={language.t("marketplace.search")}
        />
        <Show when={form.tab === "updates"}>
          <Button
            disabled={disabled()}
            onClick={() =>
              void run((signal) =>
                mutation(
                  client.updateAll(
                    {
                      location: location(),
                      expected_revision: revision(),
                    },
                    { signal },
                  ),
                ),
              )
            }
          >
            {language.t("marketplace.updateAll")}
          </Button>
        </Show>
        <Show when={listings().length} fallback={<p>{language.t("marketplace.empty")}</p>}>
          <For each={listings()}>
            {(listing) => {
              const installed = () => view()?.state.installed?.[listing.key]
              const toggle = (component: "package" | "skill" | "mcp", enabled: boolean, id?: string) =>
                run((signal) =>
                  mutation(
                    client.toggle(
                      {
                        location: location(),
                        key: listing.key,
                        expected_revision: revision(),
                        component,
                        enabled,
                        id,
                      },
                      { signal },
                    ),
                  ),
                )
              return (
                <section class="flex flex-col gap-2 border rounded p-3">
                  <div class="flex items-center gap-2">
                    <MarketplaceLogo item={listing.item} />
                    <strong class="flex-1">{listing.item.name}</strong>
                    <span>{listing.item.version}</span>
                    <Show when={installed()}>
                      <Switch
                        checked={installed()?.enabled !== false}
                        disabled={disabled()}
                        onChange={(enabled) => void toggle("package", enabled)}
                      >
                        {language.t("marketplace.enabled")}
                      </Switch>
                    </Show>
                  </div>
                  <p>{listing.item.description}</p>
                  <p>
                    {listing.item.kind} · {listing.source.name} · {listing.source.trust}
                  </p>
                  <For each={listing.item.setup}>{(instruction) => <p>{instruction}</p>}</For>
                  <div class="flex gap-2">
                    <Show when={!installed() || listing.status === "update"}>
                      <Button disabled={disabled()} onClick={() => void plan(listing)}>
                        {language.t(installed() ? "marketplace.update" : "marketplace.install")}
                      </Button>
                    </Show>
                    <Show when={installed()}>
                      <Button
                        disabled={disabled()}
                        onClick={() =>
                          void run((signal) =>
                            mutation(
                              client.uninstall(
                                {
                                  location: location(),
                                  key: listing.key,
                                  expected_revision: revision(),
                                },
                                { signal },
                              ),
                            ),
                          )
                        }
                      >
                        {language.t("marketplace.uninstall")}
                      </Button>
                    </Show>
                  </div>
                  <Show when={installed()}>
                    <For each={listing.item.install.skills?.items}>
                      {(skill) => (
                        <Switch
                          checked={!installed()?.disabled_skills?.includes(skill.id)}
                          disabled={disabled()}
                          onChange={(enabled) => void toggle("skill", enabled, skill.id)}
                        >
                          {skill.name}
                        </Switch>
                      )}
                    </For>
                    <For each={Object.keys(listing.item.install.mcp ?? {})}>
                      {(name) => (
                        <Switch
                          checked={!installed()?.disabled_mcp?.includes(name)}
                          disabled={disabled()}
                          onChange={(enabled) => void toggle("mcp", enabled, name)}
                        >
                          {name}
                        </Switch>
                      )}
                    </For>
                  </Show>
                </section>
              )
            }}
          </For>
        </Show>
      </Show>
    </div>
  )
}
