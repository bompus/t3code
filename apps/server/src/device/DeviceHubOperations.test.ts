import { assert, it } from "@effect/vitest";
import { LOCAL_DEVICE_HOST_ID } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";

const operationsAnsweringAfter = (delay: Duration.Duration) =>
  makeDeviceHubOperations({
    hostId: LOCAL_DEVICE_HOST_ID,
    origin: "http://device.test",
    http: HttpClient.make((request) =>
      Effect.sleep(delay).pipe(
        Effect.as(HttpClientResponse.fromWeb(request, Response.json({ ok: true }))),
      ),
    ),
    run: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
    androidAvailable: Effect.succeed(true),
  });

it.effect("shutdown outlasts the hub's ordinary query timeout", () =>
  Effect.gen(function* () {
    const operations = operationsAnsweringAfter(Duration.seconds(40));
    const fiber = yield* operations
      .shutdown({ id: "emulator-5554", platform: "android" })
      .pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.seconds(40));
    assert.isTrue(Exit.isSuccess(yield* Fiber.await(fiber)));
  }),
);

it.effect("shutdown still gives up when the hub never answers", () =>
  Effect.gen(function* () {
    const operations = operationsAnsweringAfter(Duration.minutes(10));
    const fiber = yield* operations
      .shutdown({ id: "emulator-5554", platform: "android" })
      .pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.seconds(61));
    assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)));
  }),
);
