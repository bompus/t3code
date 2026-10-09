import type { Root } from "hast";
import { parseChatMarkdownChunks } from "./markdown-progressive-pipeline";

export interface ChatMarkdownWorkerRequest {
  readonly id: number;
  readonly text: string;
  readonly lineBreaks: boolean;
}

export interface ChatMarkdownWorkerReply {
  readonly id: number;
  readonly chunks?: Root[];
  readonly error?: string;
}

self.addEventListener("message", (event: MessageEvent<ChatMarkdownWorkerRequest>) => {
  const { id, text, lineBreaks } = event.data;
  let reply: ChatMarkdownWorkerReply;
  try {
    reply = { id, chunks: parseChatMarkdownChunks(text, lineBreaks) };
  } catch (error) {
    reply = { id, error: String(error) };
  }
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Workers do not accept a target origin.
  self.postMessage(reply);
});
