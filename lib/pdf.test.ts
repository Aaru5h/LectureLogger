import { test } from "node:test";
import assert from "node:assert/strict";
import { generateNotesPdfDoc, cleanPdfText } from "./pdf.ts";

test("cleanPdfText sanitizes non-breaking hyphens, emojis, and symbols", () => {
  const input = "Flip\u2011Flops \u{1F4CC} \u{1F4A1} level\u2011triggered \u2192 clock \u03C4 \u2248 approx \u2082";
  const cleaned = cleanPdfText(input);

  assert.ok(!cleaned.includes("\u2011"), "Non-breaking hyphens converted to standard hyphens");
  assert.ok(!cleaned.includes("\u{1F4CC}"), "Pushpin emoji removed");
  assert.ok(!cleaned.includes("\u{1F4A1}"), "Lightbulb emoji removed");
  assert.ok(cleaned.includes("Flip-Flops"), "Hyphenated text preserved");
  assert.ok(cleaned.includes("level-triggered"), "Hyphenated text preserved");
  assert.ok(cleaned.includes("->"), "Arrow converted");
  assert.ok(cleaned.includes("tau"), "Greek tau converted");
  assert.ok(cleaned.includes("~"), "Approx symbol converted");
  assert.ok(cleaned.includes("2"), "Subscript converted");
});

test("generates valid PDF document from lecture markdown", () => {
  const sampleMarkdown = `
# Lecture 1: Introduction to Corporate Governance

## Vision, Mission, and Strategy

- The **board of directors** helps shape the company's long-term goal, strategy, and overall direction.
- A clear **vision** states *what* the organization aspires to become; a **mission** describes *how* it will achieve that vision.
- During implementation (e.g., in a factory or operational unit) teams often drift from the original vision.

> 📌 **Added context:**
> **Vision** — a forward-looking statement that defines the desired future state of the organization.
> **Mission** — a concise declaration of the organization's purpose and primary objectives.

### Key Takeaways
1. Align operations with strategic intent.
2. Establish independent board oversight.
3. Review progress regularly.

\`\`\`python
# Example pseudo-code
def governance_check():
    return True
\`\`\`
`;

  const doc = generateNotesPdfDoc(sampleMarkdown);
  assert.ok(doc, "jsPDF instance created");
  assert.ok(doc.getNumberOfPages() >= 1, "At least 1 page created");

  const output = doc.output();
  assert.ok(output.length > 500, "PDF output is non-empty");
  assert.match(output, /%PDF/, "Contains PDF header signature");
});

test("does not produce 2-byte NUL character spacing or leaked asterisks on complex lecture markdown", () => {
  const lectureMarkdown = `
## Introduction to Latches and Flip‑Flops  

- **Latch** — a **level‑triggered** storage element; its output follows the input while the enable (often called *clock*) signal is at a particular logic level (high or low).  
- **Flip‑flop** — an **edge‑triggered** storage element; its output changes only on a transition (rising or falling edge) of the clock signal.  
- The key distinction is **level vs. edge** triggering: a latch is transparent as long as the enable level is active, whereas a flip‑flop captures data only at a clock edge.  

> 📌 **Added context:** In digital design, "level‑triggered" means the device is *transparent* (input passes to output) whenever the control signal is at the active level. "Edge‑triggered" means the device samples the input *once* at the moment the control signal makes a transition, then becomes opaque until the next edge.

## D Latch Operation  

- **Enable (clock) signal** is typically **active high**.  
- While **enable = 1**:  
- When **enable = 0**:  
- Initial state may be assumed **0** (or **1**) until the first enable pulse.  

> 💡 **Added context:** The timing diagram of a D latch shows a rectangular enable pulse.
`;

  const doc = generateNotesPdfDoc(lectureMarkdown);
  const rawOutput = doc.output();

  // Ensure no NUL bytes from UTF-16 fallback
  assert.ok(!rawOutput.includes("\x00"), "PDF text stream contains no NUL bytes");
  // Ensure words like Flip-Flops aren't corrupted with spaces
  assert.ok(!rawOutput.includes("( F l i p"), "Words are not expanded with character spacing");
  // Ensure asterisks are not printed in output for bold words
  assert.ok(!rawOutput.includes("**Latch**"), "Bold syntax is parsed instead of leaked raw");
  assert.ok(!rawOutput.includes("**level"), "Inline bold syntax in list item is parsed");
});

test("handles empty or minimal notes without crashing", () => {
  const doc = generateNotesPdfDoc("");
  assert.ok(doc);
  assert.equal(doc.getNumberOfPages(), 1);
});

test("handles multi-page long notes with pagination and headings", () => {
  const sections = Array.from({ length: 25 }, (_, i) => `
## Topic Section ${i + 1}
- Discussion item with **bold text**, *italic notes*, and \`inline code\`.
- Supporting point with extra details explaining the concept.

> 💡 **Added context for topic ${i + 1}:** Detailed explanation of the concepts discussed.
`).join("\n");

  const doc = generateNotesPdfDoc(sections);
  assert.ok(doc.getNumberOfPages() > 1, "Multi-page PDF generated");
});
