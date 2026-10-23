import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// No query filters orchestration_events by correlation_id (the column is
// only selected back out), so the index is pure append cost: on a real
// 3.0M-event database it occupies 48 MB and is maintained on every insert.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX IF EXISTS idx_orch_events_correlation_id`;
});
