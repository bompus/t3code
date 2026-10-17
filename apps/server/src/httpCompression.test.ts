import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpServerResponse, type HttpPlatform } from "effect/http";
import * as NodeZlib from "node:zlib";
import { describe } from "vite-plus/test";

import { withLargeOutputChunks } from "./httpCompression.ts";

const decoders: Record<HttpPlatform.CompressionAlgorithm, (input: Buffer) => Buffer> = {
  gzip: NodeZlib.gunzipSync,
  deflate: NodeZlib.inflateSync,
  br: NodeZlib.brotliDecompressSync,
  zstd: NodeZlib.zstdDecompressSync,
};

/** Deterministic xorshift bytes: incompressible, so output spans several chunks. */
const incompressibleBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  let state = 0x9e3779b9;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
};

const unusedBase: HttpPlatform.Compression = {
  algorithms: new Set(["gzip", "deflate", "br", "zstd"]),
  compressResponse: (response) => Effect.succeed(response),
};

// The levels HttpMiddleware.compression() uses by default.
const levels: Record<HttpPlatform.CompressionAlgorithm, number> = {
  gzip: 6,
  deflate: 6,
  br: 4,
  zstd: 3,
};

const compress = (
  body: Uint8Array,
  algorithm: HttpPlatform.CompressionAlgorithm,
  headers: Record<string, string> = {},
) =>
  withLargeOutputChunks(unusedBase).compressResponse(
    HttpServerResponse.uint8Array(body, { contentType: "application/json", headers }),
    algorithm,
    { level: levels[algorithm] },
  );

/** The same async call with Node's default 16 KiB chunking, the output to match. */
const reference = (body: Uint8Array, algorithm: HttpPlatform.CompressionAlgorithm) =>
  Effect.callback<Uint8Array>((resume) => {
    const level = levels[algorithm];
    const done = (error: Error | null, result: Uint8Array) =>
      resume(error === null ? Effect.succeed(result) : Effect.die(error));
    switch (algorithm) {
      case "gzip":
        NodeZlib.gzip(body, { level }, done);
        break;
      case "deflate":
        NodeZlib.deflate(body, { level }, done);
        break;
      case "br":
        NodeZlib.brotliCompress(
          body,
          {
            params: {
              [NodeZlib.constants.BROTLI_PARAM_QUALITY]: level,
              [NodeZlib.constants.BROTLI_PARAM_SIZE_HINT]: body.byteLength,
            },
          },
          done,
        );
        break;
      case "zstd":
        NodeZlib.zstdCompress(
          body,
          { params: { [NodeZlib.constants.ZSTD_c_compressionLevel]: level } },
          done,
        );
        break;
    }
  });

describe("withLargeOutputChunks", () => {
  it.effect.each(["gzip", "deflate", "br", "zstd"] as const)(
    "%s output decodes to the original body and sets headers",
    (algorithm) =>
      Effect.gen(function* () {
        const body = incompressibleBytes(3 * 1024 * 1024);
        const response = yield* compress(body, algorithm, {
          etag: '"abc"',
          vary: "Origin",
        });

        expect(response.body._tag).toBe("Uint8Array");
        if (response.body._tag !== "Uint8Array") return;
        expect(response.body.body.byteLength).toBeGreaterThan(1024 * 1024);
        expect(Buffer.from(response.body.body).equals(yield* reference(body, algorithm))).toBe(
          true,
        );
        expect(decoders[algorithm](Buffer.from(response.body.body)).equals(body)).toBe(true);
        expect(response.headers["content-encoding"]).toBe(algorithm);
        expect(response.headers["content-length"]).toBe(String(response.body.body.byteLength));
        expect(response.headers["vary"]).toBe("Origin, Accept-Encoding");
        expect(response.headers["etag"]).toBe('W/"abc"');
        expect(response.headers["content-type"]).toContain("application/json");
      }),
  );

  it.effect.each(["gzip", "deflate", "br", "zstd"] as const)(
    "%s output for a small body matches Node's default chunking",
    (algorithm) =>
      Effect.gen(function* () {
        const body = new TextEncoder().encode(JSON.stringify({ rows: "x".repeat(5000) }));
        const response = yield* compress(body, algorithm);

        expect(response.body._tag).toBe("Uint8Array");
        if (response.body._tag !== "Uint8Array") return;
        expect(Buffer.from(response.body.body).equals(yield* reference(body, algorithm))).toBe(
          true,
        );
      }),
  );

  it.effect("keeps an existing Vary that already covers Accept-Encoding", () =>
    Effect.gen(function* () {
      const body = new TextEncoder().encode("x".repeat(4096));
      const star = yield* compress(body, "gzip", { vary: "*" });
      const listed = yield* compress(body, "gzip", { vary: "Origin, accept-encoding" });
      expect(star.headers["vary"]).toBe("*");
      expect(listed.headers["vary"]).toBe("Origin, accept-encoding");
    }),
  );

  it.effect("leaves non-byte-array bodies to the wrapped compression", () =>
    Effect.gen(function* () {
      const streamed = HttpServerResponse.text("hello");
      const base: HttpPlatform.Compression = {
        algorithms: unusedBase.algorithms,
        compressResponse: () => Effect.succeed(streamed),
      };
      const result = yield* withLargeOutputChunks(base).compressResponse(
        HttpServerResponse.empty(),
        "gzip",
        undefined,
      );
      expect(result).toBe(streamed);
    }),
  );
});
