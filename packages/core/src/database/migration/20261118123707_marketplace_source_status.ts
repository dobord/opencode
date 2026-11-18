import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261118123707_marketplace_source_status",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`marketplace_source_status\` (
          \`id\` text PRIMARY KEY,
          \`data\` text NOT NULL
        );
      `)
    })
  },
}

export default migration
