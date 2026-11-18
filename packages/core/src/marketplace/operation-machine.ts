export * as MarketplaceOperationMachine from "./operation-machine.js"

import { MarketplaceOperation } from "@opencode/schema/marketplace-operation"

export type Event = { at: number } & (
  | { type: "started" }
  | { type: "phase-changed"; phase: MarketplaceOperation.Phase; progress?: MarketplaceOperation.Progress }
  | { type: "cancel-requested" }
  | { type: "succeeded"; result: MarketplaceOperation.Result }
  | { type: "failed"; error: MarketplaceOperation.Failure }
  | { type: "cancelled" }
  | { type: "interrupted" }
)

export function active(info: MarketplaceOperation.Info) {
  return info.status === "queued" || info.status === "running" || info.status === "cancelling"
}

export function cancellable(info: MarketplaceOperation.Info) {
  if (info.status === "queued") return true
  return info.status === "running" && info.phase !== "applying" && info.phase !== "refreshing-config"
}

/** Durable lifecycle transitions. High-frequency transfer samples belong to the live controller, not this state log. */
export function transition(info: MarketplaceOperation.Info, event: Event): MarketplaceOperation.Info {
  if (!active(info)) return info
  const base = {
    id: info.id,
    kind: info.kind,
    ...(info.target === undefined ? {} : { target: info.target }),
    ...(info.outcomes === undefined ? {} : { outcomes: info.outcomes }),
    ...(info.warnings === undefined ? {} : { warnings: info.warnings }),
    location: info.location,
    created_at: info.created_at,
    updated_at: event.at,
    version: info.version + 1,
  }
  if (info.status === "queued") {
    if (event.type === "started") return { ...base, status: "running", started_at: event.at, phase: "starting" }
    if (event.type === "cancel-requested") return { ...base, status: "cancelled", finished_at: event.at }
    return info
  }
  if (event.type === "phase-changed") {
    if (info.status === "cancelling") return info
    return {
      ...base,
      status: "running",
      started_at: info.started_at,
      phase: event.phase,
      ...(event.progress ? { progress: event.progress } : {}),
    }
  }
  if (event.type === "cancel-requested") {
    if (!cancellable(info)) return info
    return { ...info, ...base, status: "cancelling" }
  }
  const finished = { ...base, started_at: info.started_at, finished_at: event.at }
  // Completion can win a late cancellation after the registry has committed.
  if (event.type === "succeeded") return { ...finished, status: "succeeded", result: event.result }
  if (event.type === "failed") return { ...finished, status: "failed", error: event.error }
  if (event.type === "interrupted") return { ...finished, status: "interrupted" }
  if (event.type === "cancelled" && info.status === "cancelling") return { ...finished, status: "cancelled" }
  return info
}
