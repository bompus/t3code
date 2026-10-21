import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Latest event sequence across the given threads and every thread they fork
 * from. Cached reads compare it with the value they were built at.
 */
export const makeThreadRevisionReader = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const encodeThreadIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(ThreadId)));
  return Effect.fn("ThreadFind.readRevision")(function* (threadIds: readonly ThreadId[]) {
    const sources = yield* encodeThreadIds(threadIds);
    const revision = yield* sql<{ sequence: number }>`
      WITH RECURSIVE source_threads(thread_id) AS (
        SELECT value FROM json_each(${sources})
        UNION
        SELECT json_extract(t.payload_json, '$.forkedFrom.threadId')
        FROM orchestration_v2_projection_threads t
        JOIN source_threads s ON s.thread_id = t.thread_id
        WHERE json_extract(t.payload_json, '$.forkedFrom.type') = 'run'
      )
      SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events
      -- The planner otherwise walks every V2 event backwards from the newest,
      -- which takes seconds for a thread that has been idle a long time.
      INDEXED BY idx_orch_events_stream_sequence
      WHERE application_event_version = 2 AND aggregate_kind = 'thread'
        AND stream_id IN (SELECT thread_id FROM source_threads)
    `;
    return revision[0]?.sequence ?? 0;
  });
});
