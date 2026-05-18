import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateSmsParts,
  normalizeSmsText,
  splitSmsText,
} from "../src/client.ts";

test("normalizeSmsText keeps SMS output plain ASCII", () => {
  assert.equal(
    normalizeSmsText("  \u201cHello\u201d\u2014Tim\u2026\u00a0\n\n\n\u{1f680}  "),
    '"Hello"-Tim...',
  );
});

test("splitSmsText drops empty messages after normalization", () => {
  assert.deepEqual(splitSmsText("   \u{1f680}   "), []);
  assert.deepEqual(splitSmsText("  ok  "), ["ok"]);
});

test("estimateSmsParts follows GSM single and multipart segment sizes", () => {
  assert.equal(estimateSmsParts(""), 0);
  assert.equal(estimateSmsParts("a".repeat(160)), 1);
  assert.equal(estimateSmsParts("a".repeat(161)), 2);
  assert.equal(estimateSmsParts("a".repeat(307)), 3);
});
