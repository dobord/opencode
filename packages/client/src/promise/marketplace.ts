import type { OpenCode } from "./client.js"
import type { ExperimentalMarketplaceOperationsGetOutput } from "./generated/types.js"

export const marketplaceOperationActive = (operation: ExperimentalMarketplaceOperationsGetOutput) =>
  operation.status === "queued" || operation.status === "running" || operation.status === "cancelling"

/** Observe server-owned work. Ending observation never cancels the operation. */
export async function waitForMarketplaceOperation(
  client: ReturnType<typeof OpenCode.make>,
  id: string,
  location: { directory: string },
  onProgress?: (operation: ExperimentalMarketplaceOperationsGetOutput) => void,
  signal?: AbortSignal,
) {
  const lifetime = new AbortController()
  const observation = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
  const stream = client.event.subscribe({ types: ["marketplace.operation.updated"], signal: observation })
  try {
    // server.connected arrives only after the stream is subscribed; read the durable
    // snapshot then so fast completion before subscription cannot be missed.
    for await (const event of stream) {
      const operation =
        event.type === "server.connected"
          ? await client.experimental.marketplace.operations.get({ id, location }, { signal: observation })
          : event.data.operation.id === id
            ? event.data.operation
            : undefined
      if (!operation) continue
      onProgress?.(operation)
      if (!marketplaceOperationActive(operation)) return operation
    }
    throw new Error(`Stopped observing Marketplace operation ${id}; the server may still be running it`)
  } finally {
    lifetime.abort()
  }
}
