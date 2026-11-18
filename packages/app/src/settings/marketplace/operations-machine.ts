import type { MarketplaceOperation } from "@opencode/schema/marketplace-operation"
import type { View } from "./machine"

export type Operation = typeof MarketplaceOperation.Info.Encoded
export type Command = MarketplaceOperation.Command
type Base = {
  attempt: number
  operations: Record<string, Operation>
  requests: Record<
    string,
    | { status: "pending"; id: string; signature: string }
    | { status: "failed"; id: string; signature: string; error: string }
  >
  open: boolean
}
export type State = Base &
  (
    | { status: "idle" }
    | { status: "loading"; location: { directory: string }; view?: View }
    | { status: "ready"; location: { directory: string }; view: View }
    | { status: "failed"; location: { directory: string }; view?: View; error: string }
    | { status: "unavailable"; location: { directory: string } }
    | { status: "disposed" }
  )
export type Event =
  | { type: "load"; location: { directory: string } }
  | { type: "loaded"; attempt: number; view: View; operations: Operation[] }
  | { type: "failed"; attempt: number; error: string; unavailable: boolean }
  | { type: "updated"; operation: Operation }
  | { type: "submit"; key: string; id: string; signature: string }
  | { type: "accepted"; key: string; id: string; operation: Operation }
  | { type: "rejected"; key: string; id: string; error: string }
  | { type: "completed"; key: string; id: string }
  | { type: "open"; open: boolean }
  | { type: "disposed" }

export const initial = (): State => ({ status: "idle", attempt: 0, operations: {}, requests: {}, open: false })
export const active = (operation: Operation) =>
  operation.status === "queued" || operation.status === "running" || operation.status === "cancelling"
export const cancellable = (operation: Operation) =>
  operation.status === "queued" ||
  (operation.status === "running" && operation.phase !== "applying" && operation.phase !== "refreshing-config")
export const resource = (command: Command) =>
  "key" in command
    ? command.key
    : "id" in command
      ? command.id
      : command.kind === "source-add"
        ? command.url
        : command.kind
export const view = (state: State) => ("view" in state ? state.view : undefined)
export const location = (state: State) => ("location" in state ? state.location : undefined)
export const pending = (state: State, key: string) =>
  state.requests[key]?.status === "pending" ||
  Object.values(state.operations).some((operation) => active(operation) && (operation.target ?? operation.kind) === key)

export function transition(state: State, event: Event): State {
  if (state.status === "disposed") return state
  if (event.type === "disposed") return { ...state, status: "disposed" }
  if (event.type === "open") return { ...state, open: event.open }
  if (event.type === "load")
    return {
      ...state,
      status: "loading",
      attempt: state.attempt + 1,
      location: event.location,
      view: location(state)?.directory === event.location.directory ? view(state) : undefined,
    }
  if (event.type === "updated") {
    if ((state.operations[event.operation.id]?.version ?? -1) >= event.operation.version) return state
    return { ...state, operations: { ...state.operations, [event.operation.id]: event.operation } }
  }
  if (event.type === "submit") {
    if (pending(state, event.key)) return state
    return {
      ...state,
      requests: { ...state.requests, [event.key]: { status: "pending", id: event.id, signature: event.signature } },
    }
  }
  if (event.type === "accepted" || event.type === "rejected" || event.type === "completed") {
    if (state.requests[event.key]?.id !== event.id) return state
    if (event.type === "rejected")
      return {
        ...state,
        requests: {
          ...state.requests,
          [event.key]: {
            status: "failed",
            id: event.id,
            signature: state.requests[event.key].signature,
            error: event.error,
          },
        },
      }
    const { [event.key]: _request, ...requests } = state.requests
    if (event.type === "completed") return { ...state, requests }
    return transition({ ...state, requests }, { type: "updated", operation: event.operation })
  }
  if (state.status !== "loading" || event.attempt !== state.attempt) return state
  if (event.type === "failed")
    return event.unavailable ? { ...state, status: "unavailable" } : { ...state, status: "failed", error: event.error }
  return {
    ...state,
    status: "ready",
    view: event.view,
    operations: event.operations.reduce(
      (operations, operation) =>
        (operations[operation.id]?.version ?? -1) >= operation.version
          ? operations
          : { ...operations, [operation.id]: operation },
      state.operations,
    ),
  }
}
