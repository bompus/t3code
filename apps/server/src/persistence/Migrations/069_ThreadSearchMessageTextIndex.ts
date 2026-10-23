import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Trigram FTS over message text so thread search prunes candidates by
// substring instead of scanning every message body. The triggers keep the
// index in step with every projection write; the one-time backfill below
// costs roughly a tenth of a millisecond per message (measured 10 s for
// 131k messages / 80 MB of text on a development machine).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE VIRTUAL TABLE orchestration_v2_projection_message_search
    USING fts5(message_id UNINDEXED, text, tokenize = 'trigram')
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_message_search(message_id, text)
    SELECT message_id, json_extract(payload_json, '$.text')
    FROM orchestration_v2_projection_messages
    WHERE json_extract(payload_json, '$.text') IS NOT NULL
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_projection_message_search_ai
    AFTER INSERT ON orchestration_v2_projection_messages
    WHEN json_extract(NEW.payload_json, '$.text') IS NOT NULL
    BEGIN
      INSERT INTO orchestration_v2_projection_message_search(message_id, text)
      VALUES (NEW.message_id, json_extract(NEW.payload_json, '$.text'));
    END
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_projection_message_search_ad
    AFTER DELETE ON orchestration_v2_projection_messages
    BEGIN
      DELETE FROM orchestration_v2_projection_message_search
      WHERE message_id = OLD.message_id;
    END
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_projection_message_search_au
    AFTER UPDATE OF payload_json ON orchestration_v2_projection_messages
    BEGIN
      DELETE FROM orchestration_v2_projection_message_search
      WHERE message_id = OLD.message_id;
      INSERT INTO orchestration_v2_projection_message_search(message_id, text)
      SELECT NEW.message_id, json_extract(NEW.payload_json, '$.text')
      WHERE json_extract(NEW.payload_json, '$.text') IS NOT NULL;
    END
  `;
});
