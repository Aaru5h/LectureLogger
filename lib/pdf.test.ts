import { test } from "node:test";
import assert from "node:assert/strict";
import { generateNotesPdfDoc } from "./pdf.ts";

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
