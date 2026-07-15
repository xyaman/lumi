// EPUB stylesheet scoping: html/body → .lumi-content rewriting. Pure string
// transforms, so no DOM/resources are needed (an empty resource map suffices as
// long as the CSS has no @import / url() to resolve).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { processCssText } from "../src/index.js";

const epub = { resources: new Map() } as unknown as Parameters<typeof processCssText>[2];
const scope = (text: string) => processCssText(text, "", epub, new Set(), []);

describe("selector scoping (html/body → .lumi-content)", () => {
  it("rewrites element html/body selectors", async () => {
    assert.equal(await scope("body { color: red }"), ".lumi-content { color: red }");
    assert.equal(await scope("html, body { margin: 0 }"), ".lumi-content, .lumi-content { margin: 0 }");
  });

  it("rewrites an element selector carrying a class", async () => {
    assert.equal(await scope("body.night { color: #fff }"), ".lumi-content.night { color: #fff }");
  });

  it("does NOT mangle a bare .body / #html class or id selector", async () => {
    // Regression: `.` before `body` must not be treated as a rewrite boundary,
    // else this became `..lumi-content` and broke the sheet.
    assert.equal(await scope(".body { padding: 0 }"), ".body { padding: 0 }");
    assert.equal(await scope("#html { padding: 0 }"), "#html { padding: 0 }");
  });

  it("leaves suffixed identifiers alone", async () => {
    assert.equal(await scope(".body_inner { x: 1 }"), ".body_inner { x: 1 }");
    assert.equal(await scope(".html-text { x: 1 }"), ".html-text { x: 1 }");
  });

  it("does not rewrite html/body inside a string value", async () => {
    assert.equal(await scope(`a::after { content: "body" }`), `a::after { content: "body" }`);
  });
});
