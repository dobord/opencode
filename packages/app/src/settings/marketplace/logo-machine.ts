export type State = "loading" | "ready" | "failed"
export type Event = "loaded" | "failed"

export function transition(state: State, event: Event): State {
  if (state !== "loading") return state
  return event === "loaded" ? "ready" : "failed"
}
