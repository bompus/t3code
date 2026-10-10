import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";

const threadId = ThreadId.make("thread:control-reads");
const providerThreadId = ProviderThreadId.make("provider-thread:control-reads");
const providerTurnId = ProviderTurnId.make("provider-turn:control-reads");
const providerSessionId = ProviderSessionId.make("session:control-reads");
const attemptId = RunAttemptId.make("attempt:control-reads");
const runId = RunId.make("run:control-reads");
const messageId = MessageId.make("message:control-reads");
const requestId = RuntimeRequestId.make("request:control-reads");
const nodeId = NodeId.make("node:control-reads");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-6" };

function fixtureEvents(now: DateTime.Utc): ReadonlyArray<OrchestrationV2DomainEvent> {
  const common = { threadId, occurredAt: now };
  return [
    {
      ...common,
      id: EventId.make("control:thread"),
      type: "thread.created",
      payload: {
        id: threadId,
        projectId: ProjectId.make("project:control-reads"),
        title: "Control reads",
        providerInstanceId,
        modelSelection,
        createdBy: "user",
        creationSource: "web",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/workspace",
        activeProviderThreadId: providerThreadId,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    },
    {
      ...common,
      id: EventId.make("control:provider-thread"),
      type: "provider-thread.updated",
      payload: {
        id: providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "native-control-thread", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      ...common,
      id: EventId.make("control:run"),
      type: "run.created",
      payload: {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: messageId,
        rootNodeId: nodeId,
        activeAttemptId: attemptId,
        status: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    },
    {
      ...common,
      id: EventId.make("control:attempt"),
      type: "run-attempt.created",
      payload: {
        id: attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId,
        providerThreadId,
        providerTurnId,
        reason: "initial",
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    },
    {
      ...common,
      id: EventId.make("control:turn"),
      type: "provider-turn.updated",
      payload: {
        id: providerTurnId,
        providerThreadId,
        nodeId,
        runAttemptId: attemptId,
        nativeTurnRef: { driver, nativeId: "native-control-turn", strength: "strong" },
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    },
    {
      ...common,
      id: EventId.make("control:message"),
      type: "message.updated",
      payload: {
        id: messageId,
        threadId,
        runId,
        nodeId,
        role: "user",
        text: "Use the smaller fix.",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      ...common,
      id: EventId.make("control:request"),
      type: "runtime-request.updated",
      payload: {
        id: requestId,
        nodeId,
        providerTurnId,
        nativeRequestRef: null,
        kind: "command",
        status: "resolved",
        responseCapability: { type: "live", providerSessionId },
        createdAt: now,
        resolvedAt: now,
      },
    },
  ];
}

const storageCases = (["sqlite", "memory"] as const).map((storage) => ({
  storage,
  storeLayer:
    storage === "sqlite"
      ? ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))
      : ProjectionStore.layerMemory,
}));

it.effect.each(storageCases)(
  "$storage: finds the active root turn without an attempt reverse link",
  ({ storeLayer }) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const events = fixtureEvents(now).map((event) =>
        event.type === "run-attempt.created"
          ? { ...event, payload: { ...event.payload, providerTurnId: null } }
          : event,
      );
      yield* Effect.forEach(events, (event) => store.apply(event), { discard: true });
      const running = yield* store.getRunningTurnContext(threadId);
      assert.equal(running.providerTurn?.id, providerTurnId);
      const turnEvent = events.find((event) => event.type === "provider-turn.updated")!;
      yield* store.apply({
        ...turnEvent,
        payload: { ...turnEvent.payload, status: "completed", completedAt: now },
      });
      assert.isUndefined((yield* store.getRunningTurnContext(threadId)).providerTurn);
    }).pipe(Effect.provide(storeLayer)),
);
const traceSqlStatements = () => {
  const statements: Array<string> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const query = span.attributes.get("db.query.text");
        if (typeof query === "string") statements.push(query);
      };
      return span;
    },
  });
  return { statements, tracer };
};
it.effect.each(storageCases)(
  "$storage: a node read by id returns only those nodes",
  ({ storage, storeLayer }) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      yield* Effect.forEach(fixtureEvents(now), (event) => store.apply(event), { discard: true });
      const otherNodeId = NodeId.make("node:control-reads-other");
      const nodeEvent = (id: NodeId) =>
        ({
          id: EventId.make(`control:${id}`),
          type: "node.updated",
          threadId,
          runId,
          nodeId: id,
          occurredAt: now,
          payload: {
            id,
            threadId,
            runId,
            parentNodeId: id === nodeId ? null : nodeId,
            rootNodeId: nodeId,
            kind: id === nodeId ? "root_turn" : "tool_call",
            status: "completed",
            countsForRun: false,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: now,
          },
        }) satisfies OrchestrationV2DomainEvent;
      yield* store.apply(nodeEvent(nodeId));
      yield* store.apply(nodeEvent(otherNodeId));
      const ids = (nodes: ReadonlyArray<{ readonly id: NodeId }>) =>
        nodes.map((node) => node.id).toSorted();
      const all = yield* store.getThreadRecords(threadId, ["nodes"]);
      const byId = yield* store.getThreadRecords(threadId, ["nodes"], { nodeIds: [nodeId] });
      const both = yield* store.getThreadRecords(threadId, ["nodes"], {
        nodeIds: [otherNodeId, nodeId],
      });
      const none = yield* store.getThreadRecords(threadId, ["nodes"], { nodeIds: [] });
      // An unknown node is never returned.
      const unmatched = yield* store.getThreadRecords(threadId, ["nodes"], {
        nodeIds: [NodeId.make("node:control-reads-unknown")],
      });
      assert.deepEqual(ids(all.nodes), [nodeId, otherNodeId].toSorted());
      assert.deepEqual(ids(byId.nodes), [nodeId]);
      assert.deepEqual(ids(both.nodes), [nodeId, otherNodeId].toSorted());
      assert.deepEqual(ids(none.nodes), []);
      assert.deepEqual(ids(unmatched.nodes), []);
      if (storage === "sqlite") {
        // Another thread's node is never returned, even when asked for by id.
        const foreignThreadId = ThreadId.make("thread:control-reads-foreign");
        const foreignNodeId = NodeId.make("node:control-reads-foreign");
        yield* store.apply({
          ...nodeEvent(foreignNodeId),
          threadId: foreignThreadId,
          payload: { ...nodeEvent(foreignNodeId).payload, threadId: foreignThreadId },
        });
        const foreign = yield* store.getThreadRecords(threadId, ["nodes"], {
          nodeIds: [foreignNodeId],
        });
        assert.deepEqual(ids(foreign.nodes), []);
        // One node is a primary-key lookup, however many nodes the thread holds.
        const { statements, tracer } = traceSqlStatements();
        yield* store
          .getThreadRecords(threadId, ["nodes"], { nodeIds: [nodeId] })
          .pipe(Effect.withTracer(tracer));
        const nodeStatement = statements.find(
          (statement) =>
            statement.includes("payload_json") &&
            statement.includes("orchestration_v2_projection_nodes") &&
            statement.includes("node_id IN"),
        );
        assert.isDefined(nodeStatement);
        const plan = yield* (yield* SqlClient.SqlClient).unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${nodeStatement}`,
        );
        assert.deepEqual(
          plan.map((row) => row.detail).filter((detail) => detail.startsWith("SEARCH ")),
          [
            "SEARCH orchestration_v2_projection_nodes USING INDEX sqlite_autoindex_orchestration_v2_projection_nodes_1 (node_id=?)",
          ],
        );
      }
    }).pipe(Effect.provide(Layer.merge(storeLayer, SqlitePersistence.layerMemory))),
);
it.effect.each(storageCases)(
  "$storage: controls and replies read only their exact durable targets",
  ({ storage, storeLayer }) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const events = fixtureEvents(now);
      yield* Effect.forEach(events, (event) => store.apply(event), { discard: true });
      if (storage === "sqlite") {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
        VALUES ('message:unrelated-obsolete', ${threadId}, ${runId}, ${nodeId}, 'assistant', 0,
          ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, '{"obsolete":"transcript"}')`;
        assert.equal((yield* Effect.exit(store.getThreadProjection(threadId)))._tag, "Failure");
        const queryPlan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
          SELECT payload_json FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND node_id = ${nodeId}
            AND type IN ('approval_request', 'user_input_request')
            AND json_extract(payload_json, '$.requestId') = ${requestId}
          ORDER BY ordinal ASC LIMIT 1`;
        assert.isTrue(queryPlan.some((row) => row.detail.includes("turn_items_node_ordinal_idx")));
      }
      const running = yield* store.getRunningTurnContext(threadId);
      assert.equal(running.run?.id, runId);
      assert.equal(running.providerThread?.id, providerThreadId);
      assert.equal(running.providerTurn?.id, providerTurnId);
      const providerContext = yield* store.getThreadProviderContext(threadId, providerInstanceId);
      assert.equal(providerContext.thread.id, threadId);
      assert.deepEqual(
        providerContext.providerThreads.map((thread) => thread.id),
        [providerThreadId],
      );
      const responseContext = yield* store.getRuntimeResponseContext(threadId, requestId);
      assert.equal(responseContext.request?.id, requestId);
      const target = { providerThreadId, providerTurnId, attemptId, messageId };
      const context = yield* store.getProviderControlContext(threadId, target);
      assert.equal(context.providerThread?.id, providerThreadId);
      assert.equal(context.providerTurn?.id, providerTurnId);
      assert.equal(context.attempt?.id, attemptId);
      assert.equal(context.message?.text, "Use the smaller fix.");
      assert.equal(context.run?.id, runId);
      assert.equal((yield* store.getRuntimeRequest(threadId, requestId))?.status, "resolved");
      assert.isUndefined(
        yield* store.getRuntimeRequest(threadId, RuntimeRequestId.make("request:missing")),
      );
      const absent = yield* store.getProviderControlContext(threadId, {
        providerThreadId: ProviderThreadId.make("provider-thread:missing"),
        providerTurnId: ProviderTurnId.make("provider-turn:missing"),
      });
      assert.isUndefined(absent.providerThread);
      assert.isUndefined(absent.providerTurn);
      const missingThread = yield* store
        .getRuntimeRequest(ThreadId.make("thread:missing"), requestId)
        .pipe(Effect.flip);
      assert.instanceOf(missingThread, ProjectionStore.ProjectionStoreThreadNotFoundError);

      const calls: string[] = [];
      const layerSessions = Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
        get: () =>
          Effect.succeed(
            Option.some({
              interruptTurn: () =>
                Effect.sync(() => {
                  calls.push("interrupt");
                }),
              steerTurn: (input: { message: { text: string }; runId: RunId }) =>
                Effect.sync(() => {
                  assert.equal(input.runId, runId);
                  calls.push(input.message.text);
                }),
              respondToRuntimeRequest: () =>
                Effect.sync(() => {
                  calls.push("reply");
                }),
            } as never),
          ),
      });
      yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        const reply = yield* RuntimeRequestService.RuntimeRequestServiceV2;
        yield* control.interrupt({ threadId, providerThreadId, providerTurnId, providerSessionId });
        yield* control.steer({
          threadId,
          providerThreadId,
          providerTurnId,
          providerSessionId,
          messageId,
        });
        yield* reply.respond({ threadId, providerSessionId, requestId, decision: "accept" });
        assert.deepEqual(calls, ["interrupt", "Use the smaller fix.", "reply"]);
        const wrongSession = ProviderSessionId.make("session:wrong");
        assert.equal(
          (yield* Effect.exit(
            control.interrupt({
              threadId,
              providerThreadId,
              providerTurnId,
              providerSessionId: wrongSession,
            }),
          ))._tag,
          "Failure",
        );
        assert.equal(
          (yield* Effect.exit(
            reply.respond({
              threadId,
              providerSessionId: wrongSession,
              requestId,
              decision: "accept",
            }),
          ))._tag,
          "Failure",
        );
        assert.lengthOf(calls, 3);
        const turn = context.providerTurn!;
        yield* store.apply({
          id: EventId.make("control:turn-completed"),
          type: "provider-turn.updated",
          threadId,
          occurredAt: now,
          payload: { ...turn, status: "completed", completedAt: now },
        });
        // A settled turn's Stop still reaches the adapter, which alone knows
        // whether it runs background work for the thread.
        yield* control.interrupt({ threadId, providerThreadId, providerTurnId, providerSessionId });
        assert.deepEqual(calls, ["interrupt", "Use the smaller fix.", "reply", "interrupt"]);
      }).pipe(
        Effect.provide(
          Layer.merge(ProviderTurnControlService.layer, RuntimeRequestService.layer).pipe(
            Layer.provide(layerSessions),
          ),
        ),
      );
    }).pipe(Effect.provide(Layer.merge(storeLayer, SqlitePersistence.layerMemory))),
);
