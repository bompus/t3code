import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import * as ServerBrowserPage from "./ServerBrowserPage.ts";

describe("server browser page operations", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let cdp: CDPSession;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
  });
  afterEach(async () => {
    await context.close();
  });

  const takeSnapshot = () =>
    ServerBrowserPage.snapshot({
      page,
      cdp,
      renderScale: 1,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    });
  it("reads rendered content with warnings, links and structure without changing the DOM", async () => {
    await page.setContent(`
      <base href="https://example.com/docs/">
      <title>Reader fixture</title><nav>Outer navigation</nav>
      <main><h1>Rendered documentation</h1>
        <nav>Inner navigation</nav><aside>Warning: preserve this instruction.</aside>
        <p><a href="guide">Read the guide</a></p><img src="diagram.png">
        <table><tr><th>Feature</th><th>State</th></tr><tr><td>Reader</td><td>Optional</td></tr></table>
        <pre><code class="language-js">const answer = 42;</code></pre>
        <ul><li>First item</li></ul><details><summary>More</summary>Collapsed explanation</details>
        <p hidden>Hidden draft</p><p style="display:none">CSS hidden draft</p>
        <div style="content-visibility:hidden">Unrendered hidden draft</div>
        <div style="visibility:hidden">Invisible draft<aside style="visibility:visible">Visible warning</aside></div>
        <input value="private-input"><textarea>private-textarea</textarea>
        <select><option>private-selection</option></select>
        <x-reader>Custom block text</x-reader><div id="dynamic"></div><footer>Footer links</footer>
      </main>
      <script>
        window.upgrades = 0;
        customElements.define('x-reader', class extends HTMLElement {
          constructor() { super(); window.upgrades++; }
        });
        document.querySelector('#dynamic').textContent = 'Loaded JavaScript content';
      </script>`);
    const original = await page.content();
    const result = await ServerBrowserPage.read(page, {});
    expect(result.title).toBe("Reader fixture");
    expect(result.scope).toBe("main");
    expect(result.truncated).toBe(false);
    for (const text of [
      "# Rendered documentation",
      "Warning: preserve this instruction.",
      "Visible warning",
      "[Read the guide](https://example.com/docs/guide)",
      "https://example.com/docs/diagram.png",
      "| Feature | State |",
      "const answer = 42;",
      "First item",
      "Collapsed explanation",
      "Custom block text",
      "Loaded JavaScript content",
    ])
      expect(result.markdown).toContain(text);
    for (const text of [
      "navigation",
      "Hidden draft",
      "CSS hidden draft",
      "Unrendered hidden draft",
      "Invisible draft",
      "private-",
      "Footer links",
    ])
      expect(result.markdown).not.toContain(text);
    expect(result.warnings.join(" ")).toContain("shadow DOM");
    expect(await page.content()).toBe(original);
    expect(await page.evaluate("window.upgrades")).toBe(1);
  });

  it("omits CSS-hidden images while preserving visible descendants and page state", async () => {
    await page.route("**/*", (route) => route.abort());
    await page.setContent(`
      <base href="https://example.invalid/">
      <style>.loading { visibility: hidden; } .visible { visibility: visible; }</style>
      <main>
        <img id="pending" class="loading" src="/pending.png" alt="Hidden pending asset">
        <div class="loading"><img class="visible" src="/visible.png" alt="Visible asset"><span class="visible">Visible warning</span></div>
      </main>`);
    const original = await page.content();
    const result = await ServerBrowserPage.read(page, {});
    expect(result.markdown).not.toContain("Hidden pending asset");
    expect(result.markdown).not.toContain("pending.png");
    expect(result.markdown).toContain("Visible asset");
    expect(result.markdown).toContain("visible.png");
    expect(result.markdown).toContain("Visible warning");
    expect((await ServerBrowserPage.read(page, { selector: "#pending" })).markdown).toBe("");
    expect(await page.content()).toBe(original);
    await page.locator("#pending").evaluate((image) => image.classList.remove("loading"));
    const loaded = await ServerBrowserPage.read(page, {});
    expect(loaded.markdown).toContain("Hidden pending asset");
    expect(loaded.markdown).toContain("pending.png");
  });

  it("selects an exact content root and rejects missing, ambiguous or invalid selectors", async () => {
    await page.setContent(
      "<article><h1>Article fallback</h1></article><section>One</section><section>Two</section>",
    );
    expect((await ServerBrowserPage.read(page, {})).scope).toBe("article");
    expect(
      (await ServerBrowserPage.read(page, { selector: "section:first-of-type" })).markdown,
    ).toBe("One");
    for (const selector of ["#missing", "section", "["])
      await expect(ServerBrowserPage.read(page, { selector })).rejects.toThrow();
    await page.setContent("<p>Body fallback</p>");
    expect((await ServerBrowserPage.read(page, {})).scope).toBe("body");
    await page.setContent(
      '<div style="content-visibility:hidden"><article>Hidden selected root</article></div>',
    );
    expect((await ServerBrowserPage.read(page, { selector: "article" })).markdown).toBe("");
  });

  it("bounds UTF-8 and escaped JSON output without splitting Unicode", async () => {
    await page.setContent(`<main><p>${'😀\\"'.repeat(15_000)}</p></main>`);
    const small = await ServerBrowserPage.read(page, { maxBytes: 513 });
    expect(Buffer.byteLength(small.markdown, "utf8")).toBeLessThanOrEqual(513);
    expect(small.markdown).not.toContain("\uFFFD");
    expect(small.truncated).toBe(true);
    expect(small.warnings.join(" ")).toContain("truncated");
    const large = await ServerBrowserPage.read(page, { maxBytes: 40_000 });
    expect(Buffer.byteLength(JSON.stringify(large), "utf8")).toBeLessThanOrEqual(60_000);
    expect(large.truncated).toBe(true);
  });

  it("rejects oversized HTML before conversion and permits a smaller selected section", async () => {
    await page.setContent(`<main>${"x".repeat(1_000_000)}</main><article>Small section</article>`);
    await expect(ServerBrowserPage.read(page, {})).rejects.toThrow("input limit");
    expect((await ServerBrowserPage.read(page, { selector: "article" })).markdown).toBe(
      "Small section",
    );
  });
  const locators = (tree: unknown) => {
    expect(typeof tree).toBe("string");
    return Array.from(
      String(tree).matchAll(/\[ref=([^\]]+)\]/g),
      (match) => `aria-ref=${match[1]}`,
    );
  };
  const buttonLocator = (tree: unknown, name: string) => {
    const line = String(tree)
      .split("\n")
      .find((line) => line.includes(`button "${name}"`));
    const locator = locators(line)[0];
    expect(locator).toBeDefined();
    return locator!;
  };
  const repeatedRows = `<ul>${Array.from({ length: 5 }, (_, i) => `<li>row ${i + 1}<button data-testid="delete-row" onclick="this.parentElement.remove()">delete</button></li>`).join("")}</ul>`;

  it("clicks the fifth repeated delete control without touching row one", async () => {
    await page.setContent(repeatedRows);
    const result = await takeSnapshot();
    const buttons = String(result.accessibilityTree)
      .split("\n")
      .filter((line) => line.includes('button "delete"'));
    expect(buttons).toHaveLength(5);
    await ServerBrowserPage.click(page, { locator: locators(buttons[4])[0]!, timeoutMs: 1_000 });
    expect(await page.locator("li").allTextContents()).toEqual([
      "row 1delete",
      "row 2delete",
      "row 3delete",
      "row 4delete",
    ]);
  });

  it("returns from a click once it opens a dialog", async () => {
    await page.setContent(
      `<button onclick="document.body.dataset.answer = String(confirm('sure?'))">Confirm</button>`,
    );
    const dialog = new Promise<import("playwright-core").Dialog>((resolve) =>
      page.once("dialog", resolve),
    );
    await ServerBrowserPage.click(page, {
      locator: buttonLocator((await takeSnapshot()).accessibilityTree, "Confirm"),
      timeoutMs: 1_000,
    });
    await (await dialog).accept();
    await expect.poll(() => page.locator("body").getAttribute("data-answer")).toBe("true");
  });

  it("rejects ambiguous CSS controls without clicking any row", async () => {
    await page.setContent(repeatedRows);
    await expect(
      ServerBrowserPage.click(page, {
        selector: 'button[data-testid="delete-row"]',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/strict mode violation/);
    expect(await page.locator("li").count()).toBe(5);
  });

  it("does not retarget a removed ref to a replacement node", async () => {
    await page.setContent("<button onclick=\"this.textContent='clicked'\">original</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "original");
    await page.setContent("<button onclick=\"this.textContent='clicked'\">replacement</button>");
    await expect(ServerBrowserPage.click(page, { locator, timeoutMs: 100 })).rejects.toThrow();
    expect(await page.locator("button").textContent()).toBe("replacement");
  });

  it("targets iframe input refs and preserves the parent form", async () => {
    await page.setContent(
      '<input aria-label="parent"><iframe srcdoc="<input aria-label=child>"></iframe>',
    );
    await page.frameLocator("iframe").getByRole("textbox").waitFor();
    const result = await takeSnapshot();
    const line = String(result.accessibilityTree)
      .split("\n")
      .find((line) => line.includes('textbox "child"'));
    const locator = locators(line)[0]!;
    await ServerBrowserPage.type(page, { locator, text: "inside iframe", clear: true });
    expect(await page.frameLocator("iframe").getByRole("textbox").inputValue()).toBe(
      "inside iframe",
    );
    expect(await page.getByRole("textbox", { name: "parent" }).inputValue()).toBe("");
  });

  it("rejects refs from another tab", async () => {
    await page.setContent("<button>same label</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "same label");
    const other = await context.newPage();
    await other.setContent("<button>same label</button>");
    await expect(ServerBrowserPage.click(other, { locator })).rejects.toThrow(/another tab/);
  });

  it("revokes refs on takeover and issues usable refs in the next snapshot", async () => {
    await page.setContent("<button onclick=\"this.textContent='clicked'\">continue</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    ServerBrowserPage.invalidateRefs(page);
    await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
    const fresh = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    await ServerBrowserPage.click(page, { locator: fresh });
    expect(await page.locator("button").textContent()).toBe("clicked");
  });

  it("revokes refs after navigation even when labels are identical", async () => {
    await page.goto("data:text/html,<button>continue</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    await page.goto("data:text/html,<button>continue</button><p>new document</p>");
    await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
  });

  it("only accepts refs from the most recent snapshot", async () => {
    await page.setContent("<button>continue</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    await takeSnapshot();
    await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
  });

  it.each(["aria-ref=e1", " aria-ref=e1", "css=body >> aria-ref=e1"])(
    "does not allow native refs to bypass generation validation (%s)",
    async (locator) => {
      await page.setContent("<button>continue</button>");
      await takeSnapshot();
      await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
    },
  );

  it("preserves CSS selectors containing an aria-ref attribute", async () => {
    await page.setContent(
      '<button aria-ref="save" onclick="this.textContent=\'saved\'">save</button>',
    );
    await ServerBrowserPage.click(page, { selector: 'button[aria-ref="save"]' });
    expect(await page.locator("button").textContent()).toBe("saved");
  });

  it("preserves quoted attribute values containing ref engine text", async () => {
    await page.setContent(
      '<button data-example=" >> aria-ref=e1" onclick="this.textContent=\'saved\'">save</button>',
    );
    await ServerBrowserPage.click(page, { selector: 'button[data-example=" >> aria-ref=e1"]' });
    expect(await page.locator("button").textContent()).toBe("saved");
  });

  it("right-clicks, double-clicks, hovers, selects, and drags like a pointer user", async () => {
    await page.setContent(`
      <style>#menu { position: absolute; display: none } #hover:hover + #menu { display: block }</style>
      <button id="target">target</button>
      <div id="hover">hover me</div><div id="menu">menu item</div>
      <select id="size"><option value="s">Small</option><option value="l">Large</option></select>
      <div id="card" draggable="true">card</div><div id="lane" style="height:40px">lane</div>
      <p id="log"></p>
      <script>
        const log = (text) => (document.getElementById("log").textContent += text + ";");
        const target = document.getElementById("target");
        target.addEventListener("contextmenu", (event) => { event.preventDefault(); log("context"); });
        target.addEventListener("dblclick", () => log("dblclick"));
        document.getElementById("card").addEventListener("dragstart", (event) =>
          event.dataTransfer.setData("text/plain", "card"),
        );
        for (const type of ["dragenter", "dragover"])
          document.getElementById("lane").addEventListener(type, (event) => event.preventDefault());
        document.getElementById("lane").addEventListener("drop", () => log("drop"));
      </script>`);
    await ServerBrowserPage.click(page, { locator: "#target", button: "right" });
    await ServerBrowserPage.click(page, { locator: "#target", clickCount: 2 });
    await ServerBrowserPage.hover(page, { locator: "#hover" });
    expect(await page.isVisible("#menu")).toBe(true);
    // A visible label selects the same option as its value.
    expect(await ServerBrowserPage.select(page, { locator: "#size", values: ["Large"] })).toEqual({
      selected: ["l"],
    });
    await ServerBrowserPage.drag(page, { source: "#card", target: "#lane" });
    expect(await page.textContent("#log")).toBe("context;dblclick;drop;");
    await expect(
      ServerBrowserPage.select(page, { locator: "#target", values: ["s"] }),
    ).rejects.toMatchObject({ tag: "PreviewAutomationTargetNotEditableError" });
  });

  it("shows the agent's pointer at each target before the action reaches the page", async () => {
    await page.setContent(`
      <button id="go" style="position:absolute;left:100px;top:40px;width:80px;height:20px">go</button>
      <div id="tip" style="position:absolute;left:300px;top:40px;width:60px;height:20px">tip</div>
      <div id="card" draggable="true" style="position:absolute;left:20px;top:120px;width:40px;height:40px">card</div>
      <div id="lane" style="position:absolute;left:220px;top:120px;width:100px;height:40px">lane</div>
      <script>
        window.seen = [];
        go.onclick = () => seen.push("click");
        tip.onmouseenter = () => seen.push("hover");
        card.ondragstart = (event) => event.dataTransfer.setData("text/plain", "card");
        lane.ondragover = (event) => event.preventDefault();
        lane.ondrop = () => seen.push("drop");
      </script>`);
    const shown: Array<string> = [];
    const pointer: ServerBrowserPage.PointerReporter = async ({ x, y }, phase) => {
      const seen = await page.evaluate("window.seen.length");
      shown.push(`${phase}@${Math.round(x)},${Math.round(y)} after ${seen}`);
    };
    await ServerBrowserPage.click(page, { locator: "#go" }, pointer);
    await ServerBrowserPage.hover(page, { locator: "#tip" }, pointer);
    await ServerBrowserPage.drag(page, { source: "#card", target: "#lane" }, pointer);
    expect(shown).toEqual([
      "click@140,50 after 0",
      "move@330,50 after 1",
      "move@40,140 after 2",
      "move@270,140 after 2",
    ]);
    expect(await page.evaluate("window.seen")).toEqual(["click", "hover", "drop"]);
  });
});
