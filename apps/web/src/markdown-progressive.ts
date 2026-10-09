import type { Element, Nodes, Root } from "hast";
import { urlAttributes } from "html-url-attributes";
import ChatMarkdownWorker from "./markdown-progressive.worker.ts?worker";
import type {
  ChatMarkdownWorkerReply,
  ChatMarkdownWorkerRequest,
} from "./markdown-progressive.worker";

/**
 * Completed messages at least this long are parsed in a worker and mounted in slices. Shorter
 * ones keep the synchronous path, whose cost is small and whose output appears in the same
 * frame. Measured: a 1 MiB message froze the main thread ~1.5 s synchronously and ~70 ms at most
 * progressively, while a 16 KB message gained nothing. The cutoff between them is unmeasured.
 */
export const PROGRESSIVE_CHAT_MARKDOWN_MIN_LENGTH = 128 * 1024;

/** Main-thread time spent mounting slices before yielding to input and paint. */
const SLICE_BUDGET_MS = 12;
/** Parsed messages kept for remounts, such as scrolling a virtualized row back into view. */
const CACHE_SIZE = 4;

export function canRenderChatMarkdownProgressively(): boolean {
  return typeof Worker !== "undefined" && typeof MessageChannel !== "undefined";
}

interface PendingRequest {
  readonly resolve: (chunks: Root[]) => void;
  readonly reject: (error: Error) => void;
}

let worker: Worker | null = null;
let nextRequestId = 0;
const pending = new Map<number, PendingRequest>();
/** Parses still in the worker; each text is parsed once however many rows ask for it. */
const inFlight = new Map<string, Promise<Root[]>>();
/** Finished parses, least recently used first, bounded by `CACHE_SIZE`. */
const settled = new Map<string, Root[]>();

function failWorker(error: Error) {
  worker?.terminate();
  worker = null;
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

function getWorker(): Worker {
  if (worker) return worker;
  const created = new ChatMarkdownWorker();
  created.addEventListener("message", (event: MessageEvent<ChatMarkdownWorkerReply>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if (event.data.chunks) request.resolve(event.data.chunks);
    else request.reject(new Error(event.data.error ?? "Markdown worker failed"));
  });
  created.addEventListener("error", (event) =>
    failWorker(new Error(event.message || "Markdown worker failed")),
  );
  worker = created;
  return created;
}

function cacheKey(text: string, lineBreaks: boolean) {
  return `${lineBreaks ? "1" : "0"}${text}`;
}

/** The parsed slices of a message, if a previous request already finished. */
export function readChatMarkdownChunks(text: string, lineBreaks: boolean): Root[] | undefined {
  return settled.get(cacheKey(text, lineBreaks));
}

/** Parse a message in the shared worker. Concurrent and repeated requests share one parse. */
export function requestChatMarkdownChunks(text: string, lineBreaks: boolean): Promise<Root[]> {
  const key = cacheKey(text, lineBreaks);
  const done = settled.get(key);
  if (done) {
    settled.delete(key);
    settled.set(key, done);
    return Promise.resolve(done);
  }
  const running = inFlight.get(key);
  if (running) return running;
  const request = new Promise<Root[]>((resolve, reject) => {
    const id = ++nextRequestId;
    pending.set(id, { resolve, reject });
    const message: ChatMarkdownWorkerRequest = { id, text, lineBreaks };
    try {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Workers do not accept a target origin.
      getWorker().postMessage(message);
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  inFlight.set(key, request);
  request.then(
    (chunks) => {
      inFlight.delete(key);
      settled.set(key, chunks);
      for (const oldest of settled.keys()) {
        if (settled.size <= CACHE_SIZE) break;
        settled.delete(oldest);
      }
    },
    () => inFlight.delete(key),
  );
  return request;
}

type SliceTask = () => boolean;
const sliceTasks: SliceTask[] = [];
let sliceTickScheduled = false;

function runSlices() {
  sliceTickScheduled = false;
  const start = performance.now();
  while (sliceTasks.length > 0 && performance.now() - start < SLICE_BUDGET_MS) {
    const task = sliceTasks[0]!;
    if (!task()) sliceTasks.shift();
  }
  scheduleSliceTick();
}

function scheduleSliceTick() {
  if (sliceTickScheduled || sliceTasks.length === 0) return;
  sliceTickScheduled = true;
  // A message-channel task yields to input and paint without setTimeout's clamping.
  const channel = new MessageChannel();
  channel.port1.addEventListener("message", runSlices, { once: true });
  channel.port1.start();
  channel.port2.postMessage(null);
}

/**
 * Run `task` in shared time slices after the next frame, until it returns false. One queue serves
 * every message, so several large messages mounting together still yield between slices.
 * Returns a cancel function.
 */
export function scheduleChatMarkdownSlices(task: SliceTask): () => void {
  let active = true;
  const guarded: SliceTask = () => active && task();
  // Let the first slice paint before mounting the rest.
  const frame = requestAnimationFrame(() => {
    sliceTasks.push(guarded);
    scheduleSliceTick();
  });
  return () => {
    active = false;
    cancelAnimationFrame(frame);
    const index = sliceTasks.indexOf(guarded);
    if (index >= 0) sliceTasks.splice(index, 1);
  };
}

/**
 * react-markdown's post-processing for one slice: unparsed HTML becomes text and URL attributes
 * go through `urlTransform`. Copies the slice, because cached trees are rendered again on remount.
 */
export function prepareChatMarkdownSlice(
  tree: Root,
  urlTransform: (url: string, key: string, node: Element) => string,
): Root {
  const copy = (node: Nodes): Nodes => {
    if (node.type === "raw") return { type: "text", value: node.value };
    if (node.type === "root")
      return { ...node, children: node.children.map(copy) as Root["children"] };
    if (node.type !== "element") return node;
    const element: Element = {
      ...node,
      properties: { ...node.properties },
      children: node.children.map(copy) as Element["children"],
    };
    for (const [key, tagNames] of Object.entries(urlAttributes)) {
      if (
        Object.hasOwn(element.properties, key) &&
        (tagNames === null || tagNames.includes(element.tagName))
      ) {
        element.properties[key] = urlTransform(String(element.properties[key] || ""), key, element);
      }
    }
    return element;
  };
  return copy(tree) as Root;
}
