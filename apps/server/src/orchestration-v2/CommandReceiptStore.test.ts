import {
  AuthOrchestrationReadScope,
  CommandId,
  IsoDateTime,
  ProjectId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2GetCommandOutcomeResult,
  ThreadId,
  WsRpcGroup,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";
import { getCommandOutcome, WS_RPC_SERVER_OPTIONS } from "../ws.ts";
import * as SqlClient from "effect/sql/SqlClient";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";

const method = ORCHESTRATION_V2_WS_METHODS.getCommandOutcome;
const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (tag): tag is Exclude<keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES, typeof method> =>
      tag !== method,
  ),
);
const threadId = ThreadId.make("thread:outcome");
const input = { threadId, commandId: CommandId.make("command:outcome") };
const receipt: Receipts.OrchestrationCommandReceipt = {
  commandId: input.commandId,
  aggregateKind: "thread",
  aggregateId: threadId,
  commandType: "message.dispatch",
  acceptedAt: IsoDateTime.make("2026-10-07T00:00:00.000Z"),
  resultSequence: 12,
  status: "accepted",
  error: "private diagnostic must not leave the repository",
};

const testLayer = CommandReceiptStore.layerFromApplicationReceipts.pipe(
  Layer.provideMerge(Receipts.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);

it.layer(testLayer)("command outcome", (it) => {
  const clientFor = Effect.fn("clientFor")(function* (
    scopes: [typeof AuthOrchestrationReadScope] | [],
  ) {
    const responses = yield* Queue.unbounded<RpcMessage.FromServerEncoded>();
    const receive = yield* Deferred.make<Parameters<RpcServer.Protocol["Service"]["run"]>[0]>();
    const protocol = yield* RpcServer.Protocol.make((write) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(receive, write);
        const serialization = yield* RpcSerialization.RpcSerialization;
        const parser = serialization.makeUnsafe();
        return {
          disconnects: yield* Queue.unbounded<number>(),
          send: (_clientId, response) =>
            Queue.offer(
              responses,
              parser.decode(parser.encode(response)!)[0] as RpcMessage.FromServerEncoded,
            ),
          end: () => Effect.void,
          clientIds: Effect.succeed(new Set([0])),
          initialMessage: Effect.succeedNone,
          supportsAck: true,
          supportsTransferables: false,
          supportsSpanPropagation: false,
          supportsNotifications: true,
          codecFor: serialization.codecFor,
        };
      }),
    ).pipe(Effect.provide(RpcSerialization.layerJson));
    yield* RpcServer.make(group, WS_RPC_SERVER_OPTIONS).pipe(
      Effect.provide(group.toLayerHandler(method, getCommandOutcome)),
      Effect.provide(RpcAuthorization.layer(scopes)),
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.forkScoped,
    );
    const write = yield* Deferred.await(receive);
    let requestId = 0;
    return {
      [method]: (request: unknown) =>
        Effect.gen(function* () {
          yield* write(0, {
            _tag: "Request",
            id: String(++requestId),
            tag: method,
            payload: JSON.parse(JSON.stringify(request)),
            headers: [],
          });
          const response = yield* Queue.take(responses);
          assert.equal(response._tag, "Exit");
          if (response._tag !== "Exit") return yield* Effect.die("Expected an Exit response");
          if (response.exit._tag === "Success") {
            return response.exit.value as OrchestrationV2GetCommandOutcomeResult;
          }
          const failure = response.exit.cause.find((cause) => cause._tag === "Fail");
          if (failure?._tag === "Fail")
            return yield* Effect.fail(failure.error as Record<string, unknown>);
          return yield* Effect.die(response.exit.cause);
        }),
    };
  });

  it.effect(
    "returns committed outcomes without raw receipt fields or rejection admission claims",
    () =>
      Effect.gen(function* () {
        const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
        const client = yield* clientFor([AuthOrchestrationReadScope]);
        for (const status of ["accepted", "rejected"] as const) {
          yield* receipts.upsert({ ...receipt, status });
          const expected: OrchestrationV2GetCommandOutcomeResult =
            status === "accepted"
              ? { ...input, state: "accepted", commandType: "message.dispatch" }
              : {
                  ...input,
                  state: "rejected",
                  commandType: "message.dispatch",
                  admission: "unknown",
                };
          assert.deepEqual(yield* client[method](input), expected);
          assert.deepEqual(
            Option.getOrThrow(yield* receipts.getByCommandId({ commandId: input.commandId })),
            { ...receipt, status },
          );
        }
      }).pipe(Effect.scoped),
  );

  it.effect("does not disclose receipts for a different thread or project", () =>
    Effect.gen(function* () {
      const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
      const client = yield* clientFor([AuthOrchestrationReadScope]);
      const request = { ...input, commandId: CommandId.make("command:foreign") };
      const expected = { ...request, state: "unknown", reason: "not_found" } as const;
      assert.deepEqual(yield* client[method](request), expected);
      for (const aggregateKind of ["thread", "project"] as const) {
        yield* receipts.upsert({
          ...receipt,
          commandId: request.commandId,
          aggregateKind,
          aggregateId:
            aggregateKind === "thread" ? ThreadId.make("foreign") : ProjectId.make(threadId),
        });
        assert.deepEqual(yield* client[method](request), expected);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("requires read scope before touching receipt storage", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const client = yield* clientFor([]);
      yield* sql`ALTER TABLE orchestration_command_receipts RENAME TO unavailable_receipts`;
      assert.deepInclude(yield* client[method](input).pipe(Effect.flip), {
        _tag: "EnvironmentAuthorizationError",
        requiredScope: AuthOrchestrationReadScope,
      });
      yield* sql`ALTER TABLE unavailable_receipts RENAME TO orchestration_command_receipts`;
    }).pipe(Effect.scoped),
  );

  it.effect("rejects invalid wire payloads before reading storage", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const client = yield* clientFor([AuthOrchestrationReadScope]);
      yield* sql`ALTER TABLE orchestration_command_receipts RENAME TO unavailable_receipts`;
      const result = yield* client[method]({ ...input, include: "error" }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(result));
      assert.include(JSON.stringify(result), "include");
      assert.notInclude(JSON.stringify(result), "OrchestrationV2GetCommandOutcomeError");
      assert.notInclude(JSON.stringify(result), receipt.error!);
      yield* sql`ALTER TABLE unavailable_receipts RENAME TO orchestration_command_receipts`;
    }).pipe(Effect.scoped),
  );

  it.effect("reports malformed receipt reads as sanitized failures instead of unknown", () =>
    Effect.gen(function* () {
      const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
      const sql = yield* SqlClient.SqlClient;
      const client = yield* clientFor([AuthOrchestrationReadScope]);
      const request = { ...input, commandId: CommandId.make("command:malformed") };
      yield* receipts.upsert({ ...receipt, commandId: request.commandId });
      yield* sql`UPDATE orchestration_command_receipts SET accepted_at = 'not-a-date'
        WHERE command_id = ${request.commandId}`;
      const failure = yield* client[method](request).pipe(Effect.flip);
      assert.deepEqual(Object.keys(failure).sort(), ["_tag", "commandId", "threadId"].sort());
      assert.equal(failure._tag, "OrchestrationV2GetCommandOutcomeError");
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { status: "accepted" as const, commit: true },
    { status: "rejected" as const, commit: true },
    { status: "accepted" as const, commit: false },
    { status: "rejected" as const, commit: false },
  ])("does not return uncommitted $status receipts (commit=$commit)", ({ status, commit }) =>
    Effect.gen(function* () {
      const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
      const store = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const request = {
        ...input,
        commandId: CommandId.make(`command:transaction:${status}:${commit}`),
      };
      const pending = { ...receipt, commandId: request.commandId, status };
      const unknown = { ...request, state: "unknown", reason: "not_found" } as const;
      const written = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      assert.deepEqual(yield* store.getOutcome(request), unknown);
      const transaction = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* receipts.insertIfAbsent(pending);
            yield* Deferred.succeed(written, undefined);
            yield* Deferred.await(release);
            if (!commit) return yield* Effect.fail("rollback");
          }),
        )
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(written);
      const lookup = yield* store.getOutcome(request).pipe(Effect.forkChild);
      yield* TestClock.adjust(0);
      assert.isUndefined(lookup.pollUnsafe());
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(transaction);
      assert.deepEqual(
        yield* Fiber.join(lookup),
        !commit
          ? unknown
          : status === "accepted"
            ? {
                ...request,
                state: "accepted",
                commandType: "message.dispatch",
              }
            : {
                ...request,
                state: "rejected",
                commandType: "message.dispatch",
                admission: "unknown",
              },
      );
      if (commit && status === "accepted") {
        assert.isFalse(yield* receipts.insertIfAbsent({ ...pending, status: "rejected" }));
        assert.equal((yield* store.getOutcome(request)).state, "accepted");
      }
    }),
  );
});
