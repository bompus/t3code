import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * What the wire projection needs from a command's output, kept beside the payload so
 * history pages can leave the output unread. NULL means unknown (rows written earlier).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE orchestration_v2_projection_turn_items ADD COLUMN output_facts INTEGER
  `;
});
