import type { Marketplace } from "@opencode/schema/marketplace"

export type View = typeof Marketplace.View.Type
export type Listing = typeof Marketplace.Listing.Type
export type Plan = Extract<typeof Marketplace.PlanResult.Type, { ok: true }>
export type State = { attempt: number; view?: View } & (
  | { status: "idle" }
  | { status: "working" }
  | { status: "confirming"; listing: Listing; plan: Plan }
  | { status: "failed"; error: string }
  | { status: "disposed" }
)
export type Event =
  | { type: "start" }
  | { type: "loaded"; attempt: number; view: View }
  | { type: "planned"; attempt: number; listing: Listing; plan: Plan }
  | { type: "failed"; attempt: number; error: string }
  | { type: "cancel" }
  | { type: "disposed" }

export function transition(state: State, event: Event): State {
  if (state.status === "disposed") return state
  if (event.type === "disposed") return { attempt: state.attempt, status: "disposed" }
  if (event.type === "start") {
    if (state.status === "working") return state
    return { status: "working", attempt: state.attempt + 1, view: state.view }
  }
  if (event.type === "cancel") {
    if (state.status !== "confirming") return state
    return { status: "idle", attempt: state.attempt, view: state.view }
  }
  if (state.status !== "working" || event.attempt !== state.attempt) return state
  if (event.type === "loaded") return { status: "idle", attempt: state.attempt, view: event.view }
  if (event.type === "planned") return { ...state, status: "confirming", listing: event.listing, plan: event.plan }
  return { status: "failed", attempt: state.attempt, view: state.view, error: event.error }
}

export const busy = (state: State) => state.status === "working" || state.status === "disposed"
