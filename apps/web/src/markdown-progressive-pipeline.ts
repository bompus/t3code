import type { Root, RootContent } from "hast";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import {
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
} from "@t3tools/shared/markdownPipeline";
import { CHAT_MARKDOWN_RENDER_REHYPE_PLUGINS } from "./components/chatMarkdownRehype";

/** Top-level blocks per mounted slice; whitespace text between blocks travels with its slice. */
const BLOCKS_PER_CHUNK = 20;

// The processor react-markdown builds for ChatMarkdown with raw HTML parsed and no extra
// plugins. Built once per line-break mode and reused, so it can run off the main thread.
const processors = new Map<boolean, ReturnType<typeof createProcessor>>();

function createProcessor(lineBreaks: boolean) {
  return unified()
    .use(remarkParse)
    .use(lineBreaks ? CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS : CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_RENDER_REHYPE_PLUGINS);
}

/**
 * Parse and transform a whole message, then split the finished tree into top-level slices.
 * Document-wide steps (link definitions, footnotes, heading id dedupe) run before the split.
 */
export function parseChatMarkdownChunks(text: string, lineBreaks: boolean): Root[] {
  let processor = processors.get(lineBreaks);
  if (!processor) {
    processor = createProcessor(lineBreaks);
    processors.set(lineBreaks, processor);
  }
  const tree = processor.runSync(processor.parse(text), text) as Root;
  const chunks: Root[] = [];
  let children: RootContent[] = [];
  let blocks = 0;
  for (const child of tree.children) {
    children.push(child);
    if (child.type === "element" && ++blocks >= BLOCKS_PER_CHUNK) {
      chunks.push({ type: "root", children });
      children = [];
      blocks = 0;
    }
  }
  if (children.length > 0) chunks.push({ type: "root", children });
  return chunks;
}
