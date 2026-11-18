import { For, Show, createEffect } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode/ui/button"
import { TextField } from "@opencode/ui/text-field"
import { Switch } from "@opencode/ui/switch"
import { Loader } from "@opencode/ui/loader"
import { useServer } from "@/runtime/server/current"
import { useLanguage } from "@/runtime/i18n/language"
import { view, type Command } from "./operations-machine"
import { OperationCard, OperationList } from "./operations-center"
import { OperationStatus } from "./operation-status"
import { MarketplaceLogo } from "./logo"

export function BackgroundMarketplacePanel() {
  const controller = useServer().ctx.marketplace
  const language = useLanguage()
  const [form, setForm] = createStore({ tab: "discover", query: "", url: "", name: "" })
  const current = () => view(controller.state())
  const submit = (command: Command) => void controller.submit(command)
  const listings = () =>
    (current()?.listings ?? []).filter(
      (listing) =>
        (form.tab === "discover"
          ? !listing.orphaned
          : form.tab === "updates"
            ? listing.status === "update"
            : listing.status !== "available") &&
        `${listing.item.name} ${listing.item.description}`.toLowerCase().includes(form.query.toLowerCase()),
    )
  const latest = (target: string) =>
    Object.values(controller.state().operations)
      .filter((operation) => operation.target === target)
      .toSorted((a, b) => b.created_at - a.created_at)[0]
  const plans = () =>
    Object.values(controller.state().operations).filter(
      (operation) =>
        operation.kind === "prepare-install" &&
        operation.status === "succeeded" &&
        latest(operation.target ?? "")?.id === operation.id,
    )
  createEffect(() => {
    if (
      controller.state().status === "ready" &&
      current()?.source_status?.some((source) => source.status === "checking") &&
      !controller.pending("refresh")
    )
      submit({ kind: "refresh" })
  })
  return (
    <div class="flex min-h-0 flex-col gap-4 overflow-y-auto p-4" data-scrollable>
      <div class="flex flex-wrap gap-2">
        <For each={["discover", "installed", "updates", "sources"] as const}>
          {(tab) => (
            <Button variant={form.tab === tab ? "neutral" : "ghost-muted"} onClick={() => setForm("tab", tab)}>
              {language.t(`marketplace.tab.${tab}`)}
            </Button>
          )}
        </For>
        <Button disabled={controller.pending("refresh")} onClick={() => submit({ kind: "refresh" })}>
          {language.t("marketplace.refresh")}
        </Button>
        <Button disabled={controller.pending("prune")} onClick={() => submit({ kind: "prune", max_age_days: 30 })}>
          {language.t("marketplace.prune")}
        </Button>
        <Button onClick={() => controller.open(true)}>{language.t("marketplace.operations.title")}</Button>
        <Button
          disabled={controller.pending("profile")}
          onClick={() =>
            void controller.exportProfile().then((profile) => {
              if (!profile) return
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" }),
              )
              const link = document.createElement("a")
              link.href = url
              link.download = "marketplace-profile.json"
              link.click()
              URL.revokeObjectURL(url)
            })
          }
        >
          {language.t("marketplace.export")}
        </Button>
      </div>
      <Show when={controller.state().status === "loading" && !current()}>
        <Loader />
      </Show>
      <Show when={controller.state().status === "failed"}>
        <p role="alert">
          {(() => {
            const state = controller.state()
            return state.status === "failed" ? state.error : ""
          })()}
        </p>
        <Button onClick={() => void controller.load()}>{language.t("marketplace.operations.recheck")}</Button>
      </Show>
      <For each={Object.entries(controller.state().requests)}>
        {([key, request]) => (
          <Show when={request.status === "failed"}>
            <p role="alert">{request.status === "failed" ? request.error : ""}</p>
            <Button variant="ghost-muted" onClick={() => controller.dismissRequest(key, request.id)}>
              {language.t("common.close")}
            </Button>
          </Show>
        )}
      </For>
      <Show
        when={controller.state().open}
        fallback={
          <For each={plans()}>{(operation) => <OperationCard operation={operation} controller={controller} />}</For>
        }
      >
        <section class="flex flex-col gap-2" aria-label={language.t("marketplace.operations.title")}>
          <div class="flex items-center justify-between gap-2">
            <strong>{language.t("marketplace.operations.title")}</strong>
            <Button variant="ghost-muted" onClick={() => controller.open(false)}>
              {language.t("common.close")}
            </Button>
          </div>
          <OperationList controller={controller} />
        </section>
      </Show>
      <Show
        when={form.tab === "sources"}
        fallback={
          <>
            <TextField
              value={form.query}
              onChange={(value) => setForm("query", value)}
              placeholder={language.t("marketplace.search")}
            />
            <Show when={form.tab === "updates"}>
              <Button disabled={controller.pending("update-all")} onClick={() => submit({ kind: "update-all" })}>
                {language.t("marketplace.updateAll")}
              </Button>
            </Show>
            <Show when={listings().length} fallback={<p>{language.t("marketplace.empty")}</p>}>
              <For each={listings()}>
                {(listing) => {
                  const installed = () => current()?.state.installed?.[listing.key]
                  const toggle = (component: "package" | "skill" | "mcp", enabled: boolean, id?: string) =>
                    submit({ kind: "toggle", key: listing.key, component, enabled, id })
                  return (
                    <section class="flex flex-col gap-2 rounded border p-3">
                      <div class="flex items-center gap-2">
                        <MarketplaceLogo item={listing.item} />
                        <strong class="flex-1">
                          <bdi>{listing.item.name}</bdi>
                        </strong>
                        <bdi>{listing.item.version}</bdi>
                        <Show when={installed()}>
                          <Switch
                            checked={installed()?.enabled !== false}
                            disabled={controller.pending(listing.key)}
                            onChange={(enabled) => toggle("package", enabled)}
                          >
                            {language.t("marketplace.enabled")}
                          </Switch>
                        </Show>
                      </div>
                      <p>{listing.item.description}</p>
                      <p>
                        <bdi>{listing.source.name}</bdi> · {listing.item.kind} · {listing.source.trust}
                      </p>
                      <For each={listing.item.setup}>{(instruction) => <p>{instruction}</p>}</For>
                      <Show when={latest(listing.key)}>
                        {(operation) => (
                          <>
                            <OperationStatus operation={operation} />
                            <Show when={operation().status === "failed"}>
                              <p role="alert">
                                {(() => {
                                  const value = operation()
                                  return value.status === "failed" ? value.error.message : ""
                                })()}
                              </p>
                            </Show>
                          </>
                        )}
                      </Show>
                      <div class="flex gap-2">
                        <Show when={!installed() || listing.status === "update"}>
                          <Button
                            disabled={controller.pending(listing.key)}
                            onClick={() => submit({ kind: "prepare-install", key: listing.key })}
                          >
                            {language.t(installed() ? "marketplace.update" : "marketplace.install")}
                          </Button>
                        </Show>
                        <Show when={installed()}>
                          <Button
                            disabled={controller.pending(listing.key)}
                            onClick={() => submit({ kind: "uninstall", key: listing.key })}
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
                              disabled={controller.pending(listing.key)}
                              onChange={(enabled) => toggle("skill", enabled, skill.id)}
                            >
                              {skill.name}
                            </Switch>
                          )}
                        </For>
                        <For each={Object.keys(listing.item.install.mcp ?? {})}>
                          {(name) => (
                            <Switch
                              checked={!installed()?.disabled_mcp?.includes(name)}
                              disabled={controller.pending(listing.key)}
                              onChange={(enabled) => toggle("mcp", enabled, name)}
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
          </>
        }
      >
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
          disabled={!form.url.trim() || controller.pending(form.url.trim())}
          onClick={() =>
            submit({ kind: "source-add", url: form.url.trim(), name: form.name || undefined, trust: "community" })
          }
        >
          {language.t("marketplace.source.add")}
        </Button>
        <For each={current()?.state.sources}>
          {(source) => (
            <section class="flex flex-col gap-2 rounded border p-3">
              <strong>
                <bdi>{source.name}</bdi>
              </strong>
              <bdi dir="ltr" class="break-all">
                <code>{source.reference ?? source.url}</code>
              </bdi>
              <Show when={current()?.source_status?.find((status) => status.id === source.id)}>
                {(status) => (
                  <p>
                    {language.t(`marketplace.operations.source.${status().status}`)}
                    {status().message ? `: ${status().message}` : ""}
                  </p>
                )}
              </Show>
              <Show when={latest(source.id) ?? latest(source.reference ?? source.url)}>
                {(operation) => <OperationStatus operation={operation} />}
              </Show>
              <div class="flex items-center gap-2">
                <Switch
                  checked={source.enabled !== false}
                  disabled={controller.pending(source.id)}
                  onChange={(enabled) => submit({ kind: "source-toggle", id: source.id, enabled })}
                >
                  {source.name}
                </Switch>
                <Button
                  disabled={controller.pending(source.id)}
                  onClick={() => submit({ kind: "source-remove", id: source.id })}
                >
                  {language.t("marketplace.remove")}
                </Button>
              </div>
            </section>
          )}
        </For>
      </Show>
    </div>
  )
}
