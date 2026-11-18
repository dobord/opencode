export * as MarketplaceOperationStore from "./operation-store.js"

import { isDeepStrictEqual } from "util"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import { MarketplaceOperation } from "@opencode/schema/marketplace-operation"
import { Location } from "@opencode/schema/location"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Database } from "../database/database.js"
import { MarketplaceOperationMachine } from "./operation-machine.js"
import type { MarketplaceOperationContext } from "./operation-context.js"

export class ConflictError extends Schema.TaggedError<ConflictError>()("MarketplaceOperationConflict", {
  message: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("MarketplaceOperationNotFound", {
  id: MarketplaceOperation.ID,
}) {}

export type Work = { operation: MarketplaceOperation.Info; command: MarketplaceOperation.Command }
export type Admission = { request_id: string; location: Location.Ref; command: MarketplaceOperation.Command }

export interface Interface {
  readonly enqueue: (input: Admission) => Effect.Effect<MarketplaceOperation.Info, ConflictError>
  readonly get: (id: MarketplaceOperation.ID) => Effect.Effect<MarketplaceOperation.Info, NotFoundError>
  readonly list: () => Effect.Effect<MarketplaceOperation.Info[]>
  readonly claimNext: () => Effect.Effect<Work | undefined>
  readonly update: (
    id: MarketplaceOperation.ID,
    version: number,
    event: MarketplaceOperationMachine.Event,
  ) => Effect.Effect<MarketplaceOperation.Info, ConflictError | NotFoundError>
  /** Called by the future process-global worker once on startup, never by an HTTP request. */
  readonly interruptActive: () => Effect.Effect<number>
  readonly advance: (
    id: MarketplaceOperation.ID,
    event: MarketplaceOperationMachine.Event,
  ) => Effect.Effect<MarketplaceOperation.Info, NotFoundError>
  readonly completeWithin: (
    tx: MarketplaceOperationContext.Executor,
    id: MarketplaceOperation.ID,
    result: MarketplaceOperation.Result,
  ) => Effect.Effect<void>
  readonly warn: (id: MarketplaceOperation.ID, message: string) => Effect.Effect<void>
  readonly recordPackage: (
    id: MarketplaceOperation.ID,
    result: MarketplaceOperation.PackageResult,
  ) => Effect.Effect<void>
  readonly recordPackageWithin: (
    tx: MarketplaceOperationContext.Executor,
    id: MarketplaceOperation.ID,
    result: MarketplaceOperation.PackageResult,
  ) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MarketplaceOperationStore") {}

type Executor = Pick<Database.Interface["db"], "all" | "run">
type Row = { data: string; command: string }
const decodeInfo = Schema.decodeUnknownSync(Schema.fromJsonString(MarketplaceOperation.Info))
const decodeCommand = Schema.decodeUnknownSync(Schema.fromJsonString(MarketplaceOperation.Command))
const decodeLocation = Schema.decodeUnknownSync(Schema.fromJsonString(Location.Ref))

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const read = Effect.fnUntraced(function* (executor: Executor, id: MarketplaceOperation.ID) {
      const row = (yield* executor
        .all<Row>(sql`SELECT data, command FROM marketplace_operation WHERE id = ${id} LIMIT 1`)
        .pipe(Effect.orDie))[0]
      if (!row) return undefined
      return { operation: decodeInfo(row.data), command: decodeCommand(row.command) }
    })
    const write = (executor: Executor, operation: MarketplaceOperation.Info) =>
      executor
        .run(
          sql`UPDATE marketplace_operation SET data = ${JSON.stringify(operation)}, status = ${operation.status}, time_updated = ${operation.updated_at} WHERE id = ${operation.id}`,
        )
        .pipe(Effect.orDie)

    const enqueue = Effect.fn("MarketplaceOperationStore.enqueue")(function* (input: Admission) {
      const now = yield* Clock.currentTimeMillis
      // Match the persisted JSON representation: omitted optional fields and
      // explicit undefined values must identify the same retried request.
      const command = decodeCommand(JSON.stringify(input.command))
      const location = decodeLocation(JSON.stringify(input.location))
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const previous = (yield* tx.all<Row>(
              sql`SELECT data, command FROM marketplace_operation WHERE request_id = ${input.request_id} LIMIT 1`,
            ))[0]
            if (previous) {
              const operation = decodeInfo(previous.data)
              if (
                !isDeepStrictEqual(decodeCommand(previous.command), command) ||
                !isDeepStrictEqual(operation.location, location)
              )
                return yield* new ConflictError({
                  message: "Idempotency key was already used for a different Marketplace operation",
                })
              return operation
            }
            const resource = target(command)
            const operation: MarketplaceOperation.Info = {
              id: MarketplaceOperation.ID.create(),
              kind: command.kind,
              ...(resource === undefined ? {} : { target: resource }),
              location,
              status: "queued",
              version: 0,
              created_at: now,
              updated_at: now,
            }
            yield* tx.run(
              sql`INSERT INTO marketplace_operation (id, request_id, command, data, status, time_created, time_updated) VALUES (${operation.id}, ${input.request_id}, ${JSON.stringify(command)}, ${JSON.stringify(operation)}, ${operation.status}, ${now}, ${now})`,
            )
            return operation
          }),
        )
        .pipe(Effect.catch((error) => (error instanceof ConflictError ? Effect.fail(error) : Effect.die(error))))
    })

    const get = Effect.fn("MarketplaceOperationStore.get")(function* (id: MarketplaceOperation.ID) {
      const value = yield* read(db, id)
      if (!value) return yield* new NotFoundError({ id })
      return value.operation
    })

    const list = Effect.fn("MarketplaceOperationStore.list")(function* () {
      return (yield* db
        .all<{ data: string }>(sql`SELECT data FROM marketplace_operation ORDER BY sequence ASC`)
        .pipe(Effect.orDie)).map((row) => decodeInfo(row.data))
    })

    const claimNext = Effect.fn("MarketplaceOperationStore.claimNext")(function* () {
      const now = yield* Clock.currentTimeMillis
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const busy = (yield* tx.all<{ id: string }>(
              sql`SELECT id FROM marketplace_operation WHERE status IN ('running', 'cancelling') LIMIT 1`,
            ))[0]
            if (busy) return undefined
            const row = (yield* tx.all<Row>(
              sql`SELECT data, command FROM marketplace_operation WHERE status = 'queued' ORDER BY sequence ASC LIMIT 1`,
            ))[0]
            if (!row) return undefined
            const operation = MarketplaceOperationMachine.transition(decodeInfo(row.data), { type: "started", at: now })
            yield* write(tx, operation)
            return { operation, command: decodeCommand(row.command) }
          }),
        )
        .pipe(Effect.orDie)
    })

    const update = Effect.fn("MarketplaceOperationStore.update")(function* (
      id: MarketplaceOperation.ID,
      version: number | undefined,
      event: MarketplaceOperationMachine.Event,
    ) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const value = yield* read(tx, id)
            if (!value) return yield* new NotFoundError({ id })
            if (version !== undefined && value.operation.version !== version)
              return yield* new ConflictError({ message: "Marketplace operation changed concurrently" })
            const operation = MarketplaceOperationMachine.transition(value.operation, event)
            if (operation !== value.operation) yield* write(tx, operation)
            return operation
          }),
        )
        .pipe(
          Effect.catch((error) =>
            error instanceof ConflictError || error instanceof NotFoundError ? Effect.fail(error) : Effect.die(error),
          ),
        )
    })

    const interruptActive = Effect.fn("MarketplaceOperationStore.interruptActive")(function* () {
      const now = yield* Clock.currentTimeMillis
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const rows = yield* tx.all<{ data: string }>(
              sql`SELECT data FROM marketplace_operation WHERE status IN ('running', 'cancelling')`,
            )
            yield* Effect.forEach(
              rows,
              (row) =>
                write(
                  tx,
                  MarketplaceOperationMachine.transition(decodeInfo(row.data), { type: "interrupted", at: now }),
                ),
              { discard: true },
            )
            return rows.length
          }),
        )
        .pipe(Effect.orDie)
    })

    const advance = (id: MarketplaceOperation.ID, event: MarketplaceOperationMachine.Event) =>
      update(id, undefined, event).pipe(Effect.catchTag("MarketplaceOperationConflict", Effect.die))
    const completeWithin = Effect.fn("MarketplaceOperationStore.completeWithin")(function* (
      tx: Executor,
      id: MarketplaceOperation.ID,
      result: MarketplaceOperation.Result,
    ) {
      const value = yield* read(tx, id)
      if (!value || value.operation.status !== "running" || value.operation.phase !== "applying")
        return yield* Effect.die(new Error("Marketplace commit requires an active applying operation"))
      yield* write(
        tx,
        MarketplaceOperationMachine.transition(value.operation, {
          type: "succeeded",
          result,
          at: yield* Clock.currentTimeMillis,
        }),
      )
    })
    const warn = Effect.fn("MarketplaceOperationStore.warn")(function* (id: MarketplaceOperation.ID, message: string) {
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const value = yield* read(tx, id)
            if (!value) return
            yield* write(tx, {
              ...value.operation,
              version: value.operation.version + 1,
              updated_at: yield* Clock.currentTimeMillis,
              warnings: [...(value.operation.warnings ?? []), message],
            })
          }),
        )
        .pipe(Effect.orDie)
    })

    const recordPackageWithin = Effect.fn("MarketplaceOperationStore.recordPackageWithin")(function* (
      tx: Executor,
      id: MarketplaceOperation.ID,
      result: MarketplaceOperation.PackageResult,
    ) {
      const value = yield* read(tx, id)
      if (!value || value.operation.kind !== "update-all" || value.operation.status !== "running")
        return yield* Effect.die(new Error("Package settlement requires an active bulk update"))
      if (result.status === "succeeded" && value.operation.phase !== "applying")
        return yield* Effect.die(new Error("Package commit requires the applying phase"))
      yield* write(tx, {
        ...value.operation,
        version: value.operation.version + 1,
        updated_at: yield* Clock.currentTimeMillis,
        outcomes: [...(value.operation.outcomes ?? []), result],
      })
    })
    const recordPackage = (id: MarketplaceOperation.ID, result: MarketplaceOperation.PackageResult) =>
      db.transaction((tx) => recordPackageWithin(tx, id, result)).pipe(Effect.orDie)

    return Service.of({
      enqueue,
      get,
      list,
      claimNext,
      update,
      advance,
      completeWithin,
      warn,
      recordPackage,
      recordPackageWithin,
      interruptActive,
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })

function target(command: MarketplaceOperation.Command) {
  switch (command.kind) {
    case "source-add":
      return command.url
    case "source-remove":
    case "source-toggle":
      return command.id
    case "prepare-install":
    case "install":
    case "uninstall":
    case "toggle":
      return command.key
    default:
      return undefined
  }
}
