import { test } from "node:test";
import assert from "node:assert/strict";
import { appendChunk, isHallucination, mergeOverlap } from "./merge.ts";

test("drops repeated overlap words", () => {
  assert.equal(mergeOverlap("the mitochondria is the", "is the powerhouse of the cell"), "powerhouse of the cell");
});

test("keeps chunk when there is no overlap", () => {
  assert.equal(mergeOverlap("first sentence.", "second sentence."), "second sentence.");
});

test("overlap match ignores casing and punctuation", () => {
  assert.equal(mergeOverlap("we discussed entropy", "Entropy, and then free energy"), "and then free energy");
});

test("drops whole-chunk hallucinations but keeps real speech", () => {
  assert.equal(isHallucination("Thank you."), true);
  assert.equal(isHallucination("  Thanks for watching!  "), true);
  assert.equal(isHallucination(""), true);
  assert.equal(isHallucination("thank you for coming to today's lecture"), false);
});

test("appendChunk joins with a single space", () => {
  assert.equal(appendChunk("hello there ", "there world"), "hello there world");
  assert.equal(appendChunk("", "opening line"), "opening line");
  assert.equal(appendChunk("same words", "same words"), "same words");
});
