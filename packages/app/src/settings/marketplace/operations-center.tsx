import { For, Show } from "solid-js"
import { Button } from "@opencode/ui/button"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection } from "@/runtime/server/registry"
import { useLanguage } from "@/runtime/i18n/language"
import type { createMarketplaceController } from "./controller"
import { active, cancellable, type Operation } from "./operations-machine"
import { OperationStatus } from "./operation-status"

export function OperationCard(props: {
  operation: Operation
  controller: ReturnType<typeof createMarketplaceController>
}) {
  const language = useLanguage()
  const plan = () => {
    const operation = props.operation
    return operation.status === "succeeded" && operation.result.plan?.ok
      ? { plan: operation.result.plan, fingerprint: operation.result.fingerprint }
      : undefined
  }
  const error = () => (props.operation.status === "failed" ? props.operation.error.message : undefined)
  const mcp = () => (props.operation.status === "succeeded" ? props.operation.result.connect_mcp : undefined)
  return (
    <section class="flex flex-col gap-2 border rounded p-3">
      <OperationStatus operation={() => props.operation} />
      <Show when={props.operation.target}>
        <bdi dir="auto" class="break-all">
          {props.operation.target}
        </bdi>
      </Show>
      <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
      <Show when={mcp()?.length}>
        <p>{language.t("marketplace.operations.mcp", { names: mcp()?.join(", ") ?? "" })}</p>
      </Show>
      <For each={props.operation.warnings}>{(warning) => <p role="status">{warning}</p>}</For>
      <For each={props.operation.outcomes}>
        {(outcome) => (
          <div class="flex flex-col gap-1">
            <p>
              <bdi dir="auto">{outcome.key}</bdi> · {language.t(`marketplace.operations.status.${outcome.status}`)}
              {outcome.status === "failed" ? `: ${outcome.error.message}` : ""}
            </p>
            <Show when={outcome.status === "failed"}>
              <Button
                variant="ghost-muted"
                disabled={props.controller.pending(outcome.key)}
                onClick={() =>
                  void props.controller.submit({ kind: "prepare-install", key: outcome.key }, props.operation.location)
                }
              >
                {language.t("marketplace.operations.retryPackage")}
              </Button>
            </Show>
          </div>
        )}
      </For>
      <Show when={plan()}>
        {(prepared) => (
          <>
            <p>{prepared().plan.summary}</p>
            <Show when={prepared().plan.trust_warning}>
              <p>{language.t("marketplace.trustWarning")}</p>
            </Show>
            <For each={prepared().plan.conflicts}>{(conflict) => <code>{conflict.path}</code>}</For>
            <For each={prepared().plan.permissions}>{(permission) => <code>{permission}</code>}</For>
            <Button
              disabled={props.controller.pending(prepared().plan.key)}
              onClick={() => {
                const value = prepared()
                if (value.fingerprint)
                  void props.controller.submit(
                    {
                      kind: "install",
                      key: value.plan.key,
                      expected_fingerprint: value.fingerprint,
                      force: value.plan.conflicts.length > 0,
                      accept_untrusted: value.plan.trust_warning,
                    },
                    props.operation.location,
                  )
              }}
            >
              {language.t("marketplace.confirm")}
            </Button>
          </>
        )}
      </Show>
      <Show when={cancellable(props.operation)}>
        <Button variant="ghost-muted" onClick={() => void props.controller.cancel(props.operation)}>
          {language.t("common.cancel")}
        </Button>
      </Show>
      <Show when={props.operation.status === "failed" || props.operation.status === "interrupted"}>
        <Button
          variant="ghost-muted"
          onClick={() => {
            void props.controller.load()
            props.controller.open(true)
          }}
        >
          {language.t("marketplace.operations.recheck")}
        </Button>
      </Show>
    </section>
  )
}

export function MarketplaceOperationsCenter() {
  const global = useGlobal()
  const language = useLanguage()
  return (
    <div class="fixed bottom-4 end-4 z-40 flex max-w-[min(28rem,calc(100vw-2rem))] flex-col gap-2">
      <For each={global.servers.list()}>
        {(server) => (
          <Show when={global.serverCtx(ServerConnection.key(server))?.marketplace}>
            {(controller) => {
              const operations = () =>
                Object.values(controller().state().operations).toSorted((a, b) => b.created_at - a.created_at)
              const count = () => operations().filter(active).length
              return (
                <Show when={operations().length}>
                  <Button onClick={() => controller().open(!controller().state().open)}>
                    {language.t("marketplace.operations.title")} · {count()}
                  </Button>
                  <Show when={controller().state().open}>
                    <section
                      class="flex max-h-[65vh] flex-col gap-2 overflow-y-auto rounded border bg-background-base p-3 shadow-lg"
                      data-scrollable
                      aria-label={language.t("marketplace.operations.title")}
                    >
                      <div class="flex items-center justify-between gap-2">
                        <strong>{language.t("marketplace.operations.title")}</strong>
                        <Button variant="ghost-muted" onClick={() => controller().open(false)}>
                          {language.t("common.close")}
                        </Button>
                      </div>
                      <bdi dir="ltr" class="break-all text-12">
                        {controller().state().status === "idle" ? "" : ServerConnection.key(server)}
                      </bdi>
                      <For
                        each={operations()
                          .slice(0, 30)
                          .map((operation) => operation.id)}
                      >
                        {(id) => (
                          <OperationCard operation={controller().state().operations[id]} controller={controller()} />
                        )}
                      </For>
                    </section>
                  </Show>
                </Show>
              )
            }}
          </Show>
        )}
      </For>
    </div>
  )
}
