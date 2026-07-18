import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveHref } from "../src/index.js";

describe("resolveHref", () => {
  it("resolves archive-root paths and strips query/fragment components", () => {
    assert.equal(resolveHref("OEBPS/text", "/images/cover.jpg?v=1#x"), "images/cover.jpg");
  });

  it("rejects remote URLs and encoded traversal", () => {
    assert.equal(resolveHref("OEBPS", "https://example.test/a"), undefined);
    assert.equal(resolveHref("", "%2e%2e/secrets"), undefined);
    assert.equal(resolveHref("", "..\\secrets"), undefined);
  });
});
