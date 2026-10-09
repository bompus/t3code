import type { Root } from "hast";
import { describe, expect, it, vi } from "vite-plus/test";

import type {
  ChatMarkdownWorkerReply,
  ChatMarkdownWorkerRequest,
} from "./markdown-progressive.worker";

const { FakeWorker, workers } = vi.hoisted(() => {
  const workers = { created: [] as InstanceType<typeof FakeWorker>[] };
  class FakeWorker extends EventTarget {
    readonly posted: ChatMarkdownWorkerRequest[] = [];
    terminated = false;
    constructor() {
      super();
      workers.created.push(this);
    }
    postMessage(message: ChatMarkdownWorkerRequest) {
      this.posted.push(message);
    }
    reply(data: ChatMarkdownWorkerReply) {
      this.dispatchEvent(new MessageEvent("message", { data }));
    }
    terminate() {
      this.terminated = true;
    }
  }
  return { FakeWorker, workers };
});
vi.mock("./markdown-progressive.worker.ts?worker", () => ({ default: FakeWorker }));

import {
  prepareChatMarkdownSlice,
  readChatMarkdownChunks,
  requestChatMarkdownChunks,
} from "./markdown-progressive";
import { parseChatMarkdownChunks } from "./markdown-progressive-pipeline";

describe("parseChatMarkdownChunks", () => {
  it("resolves document-wide references before splitting into slices", () => {
    const text = [
      ...Array.from({ length: 45 }, (_, index) => `## Setup\n\nSee [docs][ref] ${index}.`),
      "[ref]: https://example.com/docs",
    ].join("\n\n");
    const chunks = parseChatMarkdownChunks(text, false);
    const elements = chunks.map(
      (chunk) => chunk.children.filter((child) => child.type === "element").length,
    );
    expect(elements).toEqual([20, 20, 20, 20, 10]);
    const json = JSON.stringify(chunks);
    expect(json.match(/https:\/\/example\.com\/docs/g)).toHaveLength(45);
    expect(json).toContain('"id":"user-content-setup-44"');
  });
});

describe("prepareChatMarkdownSlice", () => {
  it("transforms URL attributes and raw nodes without changing the cached slice", () => {
    const tree: Root = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "p",
          properties: {},
          children: [
            { type: "element", tagName: "a", properties: { href: "a", title: "a" }, children: [] },
            { type: "element", tagName: "img", properties: { src: "b" }, children: [] },
            { type: "raw", value: "<x>" },
          ],
        },
      ],
    };
    const before = structuredClone(tree);
    const prepared = prepareChatMarkdownSlice(tree, (url, key) => `${key}:${url}`);
    expect(tree).toEqual(before);
    expect(prepared.children[0]).toMatchObject({
      children: [
        { properties: { href: "href:a", title: "a" } },
        { properties: { src: "src:b" } },
        { type: "text", value: "<x>" },
      ],
    });
  });
});

describe("requestChatMarkdownChunks", () => {
  const chunksFor = (text: string): Root[] => [
    { type: "root", children: [{ type: "text", value: text }] },
  ];

  it("parses each text once and recovers from a worker crash", async () => {
    const texts = ["a", "b", "c", "d", "e"];
    const first = texts.map((text) => requestChatMarkdownChunks(text, false));
    // A request for a text still in the worker joins it, even after newer requests.
    expect(requestChatMarkdownChunks("a", false)).toBe(first[0]);
    const worker = workers.created[0]!;
    expect(worker.posted.map((request) => request.text)).toEqual(texts);

    for (const request of worker.posted)
      worker.reply({ id: request.id, chunks: chunksFor(request.text) });
    expect(await Promise.all(first)).toEqual(texts.map(chunksFor));
    // Four finished parses stay cached; the oldest is dropped.
    expect(readChatMarkdownChunks("e", false)).toEqual(chunksFor("e"));
    await requestChatMarkdownChunks("b", false);
    expect(readChatMarkdownChunks("a", false)).toBeUndefined();
    void requestChatMarkdownChunks("a", false);
    expect(worker.posted).toHaveLength(6);

    const lost = requestChatMarkdownChunks("f", false);
    worker.dispatchEvent(new ErrorEvent("error", { message: "boom" }));
    await expect(lost).rejects.toThrow("boom");
    expect(worker.terminated).toBe(true);
    void requestChatMarkdownChunks("f", false);
    expect(workers.created).toHaveLength(2);
    expect(workers.created[1]!.posted.map((request) => request.text)).toEqual(["f"]);
  });
});
