import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2GetCommandOutcomeResult,
} from "./orchestrationV2.ts";
import { WsRpcGroup, WsSubscribeServerConfigRpc } from "./rpc.ts";

const commandOutcomeRpc = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.getCommandOutcome);
if (commandOutcomeRpc === undefined) throw new Error("getCommandOutcome is not registered");
const decodeCommandOutcome = Schema.decodeExit(OrchestrationV2GetCommandOutcomeResult);
const decodeCommandOutcomeInput = Schema.decodeExit(commandOutcomeRpc.payloadSchema);

/**
 * The client always sends `environmentThemes`, including to servers built
 * before the field existed, whose payload schema was an empty struct. What
 * makes that safe is that such a schema accepts the request rather than
 * rejecting it -- an error here would take down the config subscription.
 */
describe("subscribeServerConfig payload compatibility", () => {
  it("is accepted by a server whose schema predates the field", () => {
    const oldServerPayload = Schema.Struct({});
    const decoded = Schema.decodeExit(oldServerPayload)({ environmentThemes: true });
    expect(Exit.isSuccess(decoded)).toBe(true);
  });

  it("is carried by a server that declares it", () => {
    const decoded = Schema.decodeSync(WsSubscribeServerConfigRpc.payloadSchema)({
      environmentThemes: true,
    });
    expect(decoded).toEqual({ environmentThemes: true });
  });

  it("stays optional, so a client that never sends it still subscribes", () => {
    const decoded = Schema.decodeSync(WsSubscribeServerConfigRpc.payloadSchema)({});
    expect(decoded).toEqual({});
  });
});

describe("WebSocket RPC contracts", () => {
  it("exposes only the V2 orchestration transport surface", () => {
    const methods = [...WsRpcGroup.requests.keys()];

    expect(methods).toEqual(expect.arrayContaining(Object.values(ORCHESTRATION_V2_WS_METHODS)));
    expect(methods.filter((method) => method.startsWith("orchestrationV1."))).toEqual([]);
  });

  it("rejects server-internal commands sent to dispatchCommand", () => {
    const dispatchCommand = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (dispatchCommand === undefined) throw new Error("dispatchCommand is not registered");
    const decode = Schema.decodeUnknownExit(dispatchCommand.payloadSchema);

    expect(
      Exit.isFailure(
        decode({
          type: "checkpoint.rollback.fail",
          commandId: "forged-rollback-failure",
          threadId: "thread-1",
          requestId: "rollback-1",
          message: "Forged failure.",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          type: "checkpoint.rollback",
          commandId: "rollback-1",
          threadId: "thread-1",
          scopeId: "scope-1",
          checkpointId: "checkpoint-1",
        }),
      ),
    ).toBe(true);
  });
});

describe("command outcome lookup contract", () => {
  it("rejects leaked receipt fields and definitive rejection admission claims", () => {
    const identity = { threadId: "thread:lookup", commandId: "command:lookup" };
    const accepted = { ...identity, state: "accepted", commandType: "message.dispatch" };
    const rejected = {
      ...identity,
      state: "rejected",
      commandType: "message.dispatch",
      admission: "unknown",
    };
    for (const valid of [
      accepted,
      rejected,
      { ...identity, state: "unknown", reason: "not_found" },
    ]) {
      expect(Exit.isSuccess(decodeCommandOutcome(valid))).toBe(true);
      expect(Exit.isFailure(decodeCommandOutcome({ ...valid, error: "private" }))).toBe(true);
    }
    expect(Exit.isFailure(decodeCommandOutcome({ ...rejected, admission: "not_admitted" }))).toBe(
      true,
    );
    expect(Exit.isFailure(decodeCommandOutcome({ ...rejected, admission: undefined }))).toBe(true);
  });
  it("rejects payload fields that attempt to widen the read", () => {
    const input = { threadId: "thread:lookup", commandId: "command:lookup" };
    expect(Exit.isSuccess(decodeCommandOutcomeInput(input))).toBe(true);
    for (const invalid of [
      { ...input, include: "error" },
      { threadId: input.threadId },
      { ...input, commandId: "" },
    ]) {
      expect(Exit.isFailure(decodeCommandOutcomeInput(invalid))).toBe(true);
    }
  });
});
