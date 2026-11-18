import { createEffect, createSignal, getOwner, onCleanup, runWithOwner, untrack, type Accessor } from "solid-js"
import { Schema } from "effect"
import { uuid } from "@opencode/util/uuid"
import { toaster, Toast } from "@opencode/ui/toast"
import { Button } from "@opencode/ui/button"
import type { createServerSdkContext } from "@/runtime/server/client"
import { formatServerError } from "@/runtime/server/errors"
import { useLanguage } from "@/runtime/i18n/language"
import { OperationStatus } from "./operation-status"
import {
  active,
  initial,
  location,
  pending,
  resource,
  transition,
  type Command,
  type Event,
  type Operation,
} from "./operations-machine"

export function createMarketplaceController(
  sdk: ReturnType<typeof createServerSdkContext>,
  currentLocation: Accessor<{ directory: string } | undefined>,
) {
  const language = useLanguage()
  const owner = getOwner()
  const [state, setState] = createSignal(initial())
  const lifetime = new AbortController()
  const notifications = new Set<number>()
  const dispatch = (event: Event) => setState((state) => transition(state, event))
  const options = () => ({ signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]) })
  const api = () => sdk.api.experimental.marketplace

  async function load(target = location(state())) {
    if (!target || lifetime.signal.aborted) return
    dispatch({ type: "load", location: target })
    const attempt = state().attempt
    try {
      const [view, operations] = await Promise.all([
        api().snapshot({ location: target }, options()),
        api().operations.list({ location: target }, options()),
      ])
      dispatch({ type: "loaded", attempt, view, operations })
    } catch (error) {
      dispatch({
        type: "failed",
        attempt,
        error: formatServerError(error, language.t),
        unavailable:
          Schema.is(Schema.Struct({ _tag: Schema.Literal("ServiceUnavailableError") }))(error) ||
          Schema.is(
            Schema.Struct({
              name: Schema.Literal("ClientError"),
              cause: Schema.Struct({ status: Schema.Literal(404) }),
            }),
          )(error),
      })
    }
  }

  function updated(operation: Operation, notify: boolean) {
    if (state().status === "disposed") return
    const previous = state().operations[operation.id]
    dispatch({ type: "updated", operation })
    if (!previous && notify && owner)
      runWithOwner(owner, () =>
        notifications.add(
          toaster.show(
            ({ toastId }) => (
              <Toast toastId={toastId}>
                <Toast.Content>
                  <Toast.Title>{language.t("marketplace.title")}</Toast.Title>
                  <Toast.Description>
                    <OperationStatus operation={() => state().operations[operation.id] ?? operation} />
                  </Toast.Description>
                  <Toast.Actions>
                    <Button
                      onClick={() => {
                        dispatch({ type: "open", open: true })
                        toaster.dismiss(toastId)
                      }}
                    >
                      {language.t("marketplace.operations.details")}
                    </Button>
                  </Toast.Actions>
                </Toast.Content>
                <Toast.CloseButton />
              </Toast>
            ),
            { persistent: true },
          ),
        ),
      )
    if (!active(operation) && (!previous || previous.version < operation.version)) void load()
  }

  onCleanup(sdk.event.on("marketplace.operation.updated", (event) => updated(event.data.operation, true)))
  createEffect(() => {
    sdk.connection.attempt()
    const target = currentLocation()
    // The app uses an empty directory for the server's default Location on Home.
    if (target) untrack(() => void load(target))
  })
  // SSE owns normal progress. A slow fallback also repairs a terminal snapshot missed during a broken stream.
  const timer = setInterval(() => {
    if (Object.values(state().operations).some(active) && sdk.connection.status() !== "connected") void load()
  }, 15_000)
  onCleanup(() => {
    clearInterval(timer)
    lifetime.abort()
    notifications.forEach((id) => toaster.dismiss(id))
    dispatch({ type: "disposed" })
  })

  return {
    state,
    load,
    open: (open: boolean) => dispatch({ type: "open", open }),
    pending: (key: string) => pending(state(), key),
    dismissRequest: (key: string, id: string) => dispatch({ type: "completed", key, id }),
    async exportProfile() {
      const target = location(state())
      if (!target || pending(state(), "profile")) return
      const id = uuid()
      dispatch({ type: "submit", key: "profile", id, signature: "profile" })
      try {
        const profile = await api().profileExport({ location: target }, options())
        dispatch({ type: "completed", key: "profile", id })
        return profile
      } catch (error) {
        dispatch({ type: "rejected", key: "profile", id, error: formatServerError(error, language.t) })
      }
    },
    async submit(command: Command, target = location(state())) {
      if (!target || lifetime.signal.aborted) return
      const key = resource(command)
      if (pending(state(), key)) return
      const previous = state().requests[key]
      const signature = JSON.stringify(command)
      const id = previous?.status === "failed" && previous.signature === signature ? previous.id : uuid()
      dispatch({ type: "submit", key, id, signature })
      try {
        const operation = await api().operations.create({ location: target, request_id: id, command }, options())
        updated(operation, true)
        dispatch({ type: "accepted", key, id, operation })
        return operation
      } catch (error) {
        dispatch({ type: "rejected", key, id, error: formatServerError(error, language.t) })
      }
    },
    async cancel(operation: Operation) {
      try {
        updated(await api().operations.cancel({ location: operation.location, id: operation.id }, options()), false)
      } catch (error) {
        dispatch({
          type: "submit",
          key: `cancel:${operation.id}`,
          id: operation.id,
          signature: `cancel:${operation.id}`,
        })
        dispatch({
          type: "rejected",
          key: `cancel:${operation.id}`,
          id: operation.id,
          error: formatServerError(error, language.t),
        })
      }
    },
  }
}
