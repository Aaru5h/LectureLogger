import { test } from "node:test";
import assert from "node:assert/strict";
import { appendChunk, isHallucination, mergeOverlap, splitSections } from "./merge.ts";

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

test("splitSections cuts on sentence boundaries and loses nothing", () => {
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  const transcript = Array.from({ length: 300 }, (_, i) => `sentence number ${i} carries five words.`).join(" ");

  const sections = splitSections(transcript, 200);
  assert.ok(sections.length > 5, "long transcript should split");
  for (const s of sections) {
    assert.ok(words(s) <= 200 + 10, `section too long: ${words(s)}`);
    assert.match(s, /\.$/, "sections end at a sentence boundary");
  }
  // Every word survives, in order.
  assert.equal(sections.join(" "), transcript);
});

test("splitSections leaves a short transcript as one section", () => {
  assert.deepEqual(splitSections("short lecture. two sentences.", 2200), ["short lecture. two sentences."]);
  assert.deepEqual(splitSections("no punctuation at all"), ["no punctuation at all"]);
});

test("appendChunk joins with a single space", () => {
  assert.equal(appendChunk("hello there ", "there world"), "hello there world");
  assert.equal(appendChunk("", "opening line"), "opening line");
  assert.equal(appendChunk("same words", "same words"), "same words");
});
