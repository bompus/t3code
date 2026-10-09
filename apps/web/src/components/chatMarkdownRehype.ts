import type { Options as ReactMarkdownOptions } from "react-markdown";
import { CHAT_MARKDOWN_REHYPE_PLUGINS } from "@t3tools/shared/markdownPipeline";

/**
 * The anchor's words, gathered through any nesting. A context label that picked up emphasis or a
 * code span still has to read as its label; `plainHastText` gives up on the first non-text child,
 * which would leave the raw context id showing in its place.
 */
export function hastPlainTextDeep(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  if ("type" in node && node.type === "text" && "value" in node && typeof node.value === "string") {
    return node.value;
  }
  if (!("children" in node) || !Array.isArray(node.children)) return "";
  return node.children.map(hastPlainTextDeep).join("");
}

export const SANITIZED_FRAGMENT_PREFIX = "user-content-";

type HeadingHastNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HeadingHastNode[];
};

/** GitHub's heading anchor slug, so `[Setup](#setup)` table-of-contents links find their heading. */
function githubHeadingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/**
 * Gives headings without an authored id GitHub's slug id, deduplicated per document. Like the
 * sanitizer's ids, they carry the `user-content-` prefix so they cannot clobber app element ids;
 * fragment lookup strips it.
 */
function rehypeHeadingIds() {
  return (tree: HeadingHastNode) => {
    // Every id already in the document, authored or assigned, so a suffix never
    // lands on one that exists: `Setup`, `Setup`, `Setup-1` get three distinct ids.
    const taken = new Set<string>();
    const collect = (node: HeadingHastNode) => {
      const id = node.properties?.id;
      if (typeof id === "string") taken.add(id);
      node.children?.forEach(collect);
    };
    collect(tree);
    const nextSuffix = new Map<string, number>();
    const visit = (node: HeadingHastNode) => {
      if (node.type === "element" && node.tagName && /^h[1-6]$/.test(node.tagName)) {
        const slug = githubHeadingSlug(hastPlainTextDeep(node));
        if (node.properties?.id === undefined && slug) {
          let count = nextSuffix.get(slug) ?? 0;
          let id = `${SANITIZED_FRAGMENT_PREFIX}${slug}`;
          while (taken.has(id)) {
            count += 1;
            id = `${SANITIZED_FRAGMENT_PREFIX}${slug}-${count}`;
          }
          nextSuffix.set(slug, count);
          taken.add(id);
          node.properties = { ...node.properties, id };
        }
        return;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

// Heading ids are added after sanitizing, which would prefix them a second time.
export const CHAT_MARKDOWN_RENDER_REHYPE_PLUGINS = [
  ...CHAT_MARKDOWN_REHYPE_PLUGINS,
  rehypeHeadingIds,
] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;

export const CHAT_MARKDOWN_LITERAL_HTML_REHYPE_PLUGINS = [rehypeHeadingIds] satisfies NonNullable<
  ReactMarkdownOptions["rehypePlugins"]
>;
