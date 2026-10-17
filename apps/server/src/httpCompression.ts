import * as Effect from "effect/Effect";
import { HttpBody, HttpServerResponse, type HttpPlatform } from "effect/http";
import * as NodeZlib from "node:zlib";

/**
 * Node's async zlib collects its output in 16 KiB pieces by default. For the
 * multi-megabyte JSON bodies this server sends (thread snapshots), allocating
 * and joining that many pieces is a measurable share of the compression time,
 * so large bodies get bigger pieces. Small bodies keep the default size because
 * every call allocates its output buffer up front.
 */
const DEFAULT_CHUNK_SIZE = 16 * 1024;
const MAX_OUTPUT_CHUNK_SIZE = 1024 * 1024;

const outputChunkSize = (inputBytes: number) =>
  Math.min(MAX_OUTPUT_CHUNK_SIZE, Math.max(DEFAULT_CHUNK_SIZE, inputBytes));

const compress = (
  data: Uint8Array,
  algorithm: HttpPlatform.CompressionAlgorithm,
  level: number | undefined,
) =>
  Effect.callback<Uint8Array>((resume) => {
    const done = (error: Error | null, result: Uint8Array) =>
      resume(error === null ? Effect.succeed(result) : Effect.die(error));
    const chunkSize = outputChunkSize(data.byteLength);
    switch (algorithm) {
      case "gzip":
        NodeZlib.gzip(data, { level, chunkSize }, done);
        break;
      case "deflate":
        NodeZlib.deflate(data, { level, chunkSize }, done);
        break;
      case "br":
        NodeZlib.brotliCompress(
          data,
          {
            chunkSize,
            params: {
              ...(level === undefined ? {} : { [NodeZlib.constants.BROTLI_PARAM_QUALITY]: level }),
              [NodeZlib.constants.BROTLI_PARAM_SIZE_HINT]: data.byteLength,
            },
          },
          done,
        );
        break;
      case "zstd":
        NodeZlib.zstdCompress(
          data,
          {
            chunkSize,
            params:
              level === undefined ? {} : { [NodeZlib.constants.ZSTD_c_compressionLevel]: level },
          },
          done,
        );
        break;
    }
  });

const varyByAcceptEncoding = (vary: string | undefined): string => {
  if (vary === undefined) return "Accept-Encoding";
  const members = new Set(vary.split(",").map((member) => member.trim().toLowerCase()));
  return members.has("*") || members.has("accept-encoding") ? vary : `${vary}, Accept-Encoding`;
};

/**
 * Wraps a platform's compression so byte-array bodies are compressed with
 * output chunks sized to the body (up to 1 MiB). Negotiation, levels and every other body type stay with
 * the wrapped compression; the headers match what the platform sets for the
 * bodies it compresses itself.
 */
export const withLargeOutputChunks = (
  base: HttpPlatform.Compression,
): HttpPlatform.Compression => ({
  algorithms: base.algorithms,
  compressResponse(response, algorithm, options) {
    const body = response.body;
    if (body._tag !== "Uint8Array") {
      return base.compressResponse(response, algorithm, options);
    }
    return Effect.map(compress(body.body, algorithm, options?.level), (compressed) => {
      const etag = response.headers["etag"];
      return HttpServerResponse.setHeaders(
        HttpServerResponse.setBody(
          response,
          HttpBody.uint8Array(compressed, response.headers["content-type"] ?? body.contentType),
        ),
        {
          "content-length": compressed.byteLength.toString(),
          "content-encoding": algorithm,
          vary: varyByAcceptEncoding(response.headers["vary"]),
          ...(etag !== undefined && !etag.startsWith("W/") ? { etag: `W/${etag}` } : {}),
        },
      );
    });
  },
});
