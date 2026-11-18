import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261118113259_marketplace_operations",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`marketplace_operation\` (
          \`sequence\` integer PRIMARY KEY AUTOINCREMENT,
          \`id\` text NOT NULL UNIQUE,
          \`request_id\` text NOT NULL UNIQUE,
          \`command\` text NOT NULL,
          \`data\` text NOT NULL,
          \`status\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`marketplace_operation_status_idx\` ON \`marketplace_operation\` (\`status\`,\`sequence\`);`,
      )
    })
  },
}

export default migration
