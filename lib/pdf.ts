import { jsPDF } from "jspdf";
import { marked } from "marked";
import type { Tokens } from "marked";

interface StyledWord {
  text: string;
  font: "helvetica" | "courier";
  style: "normal" | "bold" | "italic" | "bolditalic";
  size: number;
  color: [number, number, number];
  isCode?: boolean;
}

interface StyledLineItem {
  text: string;
  font: "helvetica" | "courier";
  style: "normal" | "bold" | "italic" | "bolditalic";
  size: number;
  color: [number, number, number];
  width: number;
  isCode?: boolean;
}

interface StyledLine {
  items: StyledLineItem[];
  width: number;
  height: number;
}

// Windows-1252 / WinAnsi characters in the 0x80 - 0x9F range supported by jsPDF standard fonts
const WIN_ANSI_EXTRA = new Set([
  "\u20AC", "\u201A", "\u0192", "\u201E", "\u2026", "\u2020", "\u2021", "\u02C6",
  "\u2030", "\u0160", "\u2039", "\u0152", "\u017D", "\u2018", "\u2019", "\u201C",
  "\u201D", "\u2022", "\u2013", "\u2014", "\u02DC", "\u2122", "\u0161", "\u203A",
  "\u0153", "\u017E", "\u0178"
]);

function isWinAnsi(char: string): boolean {
  const code = char.charCodeAt(0);
  if (code >= 0x20 && code <= 0x7E) return true;
  if (code >= 0xA0 && code <= 0xFF) return true;
  if (code === 0x0A || code === 0x0D || code === 0x09) return true;
  return WIN_ANSI_EXTRA.has(char);
}

/**
 * Normalizes Unicode text to characters safely representable in PDF Type-1 fonts (WinAnsiEncoding).
 * Prevents jsPDF from falling back to 2-byte UTF-16BE encoding which inserts NUL bytes between
 * characters, causing letter-spacing stretching and severe text overlapping.
 */
export function cleanPdfText(text: string): string {
  if (!text) return "";

  const preFiltered = text
    .normalize("NFC")
    // Non-breaking hyphens, figure dashes, and math minus to standard hyphen
    .replace(/[\u2010\u2011\u2012\u2212]/g, "-")
    // Non-breaking spaces and narrow spaces to regular space
    .replace(/[\u00A0\u202F\u2007\u2009\u200A]/g, " ")
    // Zero-width spaces and joiners
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, "")
    // Mathematical and logic arrows
    .replace(/→/g, " -> ")
    .replace(/←/g, " <- ")
    .replace(/↔/g, " <-> ")
    .replace(/⇒/g, " => ")
    .replace(/⇐/g, " <= ")
    .replace(/⇔/g, " <=> ")
    // Mathematical operators
    .replace(/≈/g, " ~ ")
    .replace(/≠/g, " != ")
    .replace(/≤/g, " <= ")
    .replace(/≥/g, " >= ")
    .replace(/±/g, " +/- ")
    .replace(/×/g, "x")
    .replace(/÷/g, "/")
    .replace(/[⌈⌊]/g, "[")
    .replace(/[⌉⌋]/g, "]")
    // Subscripts & superscripts
    .replace(/₀/g, "0").replace(/₁/g, "1").replace(/₂/g, "2").replace(/₃/g, "3").replace(/₄/g, "4")
    .replace(/₅/g, "5").replace(/₆/g, "6").replace(/₇/g, "7").replace(/₈/g, "8").replace(/₉/g, "9")
    .replace(/⁰/g, "^0").replace(/¹/g, "^1").replace(/²/g, "^2").replace(/³/g, "^3").replace(/⁴/g, "^4")
    .replace(/⁵/g, "^5").replace(/⁶/g, "^6").replace(/⁷/g, "^7").replace(/⁸/g, "^8").replace(/⁹/g, "^9")
    // Common Greek symbols in notes
    .replace(/τ/g, "tau")
    .replace(/Ω/g, "Ohm")
    .replace(/μ/g, "mu")
    .replace(/π/g, "pi")
    .replace(/θ/g, "theta")
    .replace(/Δ/g, "Delta")
    .replace(/α/g, "alpha")
    .replace(/β/g, "beta")
    .replace(/λ/g, "lambda")
    .replace(/σ/g, "sigma")
    .replace(/ω/g, "omega")
    // Box-drawing characters
    .replace(/[─━]/g, "-")
    .replace(/[│┃]/g, "|")
    .replace(/[┌┐└┘├┤┼]/g, "+")
    .replace(/►/g, ">")
    .replace(/◯/g, "O")
    // Strip emojis and symbols outside BMP
    .replace(/[\u{1F300}-\u{1FAFF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{27BF}]/gu, "");

  let result = "";
  for (const ch of preFiltered) {
    if (isWinAnsi(ch)) {
      result += ch;
    } else {
      // Non-supported character fallback
      result += " ";
    }
  }

  return result;
}

function pushWords(
  words: StyledWord[],
  text: string,
  font: "helvetica" | "courier",
  style: "normal" | "bold" | "italic" | "bolditalic",
  size: number,
  color: [number, number, number],
  isCode = false
) {
  if (!text) return;
  const parts = text.split(/(\s+)/);
  for (const part of parts) {
    if (!part) continue;
    words.push({
      text: part,
      font,
      style,
      size,
      color,
      isCode,
    });
  }
}

function extractStyledWords(
  tokens: Tokens.Generic[] | undefined,
  baseSize: number,
  baseColor: [number, number, number],
  currentStyle: "normal" | "bold" | "italic" | "bolditalic" = "normal"
): StyledWord[] {
  if (!tokens || tokens.length === 0) return [];
  const words: StyledWord[] = [];

  for (const token of tokens) {
    // If token has nested inline tokens (e.g., strong, em, text with child formatting),
    // we MUST recurse into token.tokens so inline Markdown is properly rendered instead
    // of leaking raw syntax like **Latch** or ignoring nested styles.
    if ("tokens" in token && Array.isArray(token.tokens) && token.tokens.length > 0) {
      let nextStyle = currentStyle;
      if (token.type === "strong") {
        nextStyle = currentStyle === "italic" ? "bolditalic" : "bold";
      } else if (token.type === "em") {
        nextStyle = currentStyle === "bold" ? "bolditalic" : "italic";
      }
      const color = token.type === "link" ? ([79, 70, 229] as [number, number, number]) : baseColor;
      words.push(...extractStyledWords(token.tokens, baseSize, color, nextStyle));
    } else if (token.type === "strong") {
      const nextStyle = currentStyle === "italic" ? "bolditalic" : "bold";
      pushWords(words, token.text || "", "helvetica", nextStyle, baseSize, baseColor);
    } else if (token.type === "em") {
      const nextStyle = currentStyle === "bold" ? "bolditalic" : "italic";
      pushWords(words, token.text || "", "helvetica", nextStyle, baseSize, baseColor);
    } else if (token.type === "codespan") {
      pushWords(words, token.text || "", "courier", "normal", baseSize * 0.9, [15, 23, 42], true);
    } else if (token.type === "link") {
      pushWords(words, token.text || "", "helvetica", currentStyle, baseSize, [79, 70, 229]);
    } else if (token.type === "del") {
      pushWords(words, token.text || "", "helvetica", currentStyle, baseSize, baseColor);
    } else if ("text" in token && typeof token.text === "string") {
      pushWords(words, token.text, "helvetica", currentStyle, baseSize, baseColor);
    }
  }

  return words;
}

function measureWord(doc: jsPDF, item: StyledWord): number {
  doc.setFont(item.font, item.style);
  doc.setFontSize(item.size);
  return doc.getTextWidth(item.text);
}

function wrapStyledWords(
  doc: jsPDF,
  words: StyledWord[],
  maxWidth: number,
  lineHeightFactor = 1.45
): StyledLine[] {
  const lines: StyledLine[] = [];
  let currentItems: StyledLineItem[] = [];
  let currentWidth = 0;
  let maxFontSize = 0;

  for (const word of words) {
    if (word.text.includes("\n")) {
      const subparts = word.text.split("\n");
      for (let s = 0; s < subparts.length; s++) {
        if (s > 0) {
          // Remove trailing spaces before line break
          if (currentItems.length > 0 && /^\s+$/.test(currentItems[currentItems.length - 1].text)) {
            const last = currentItems.pop()!;
            currentWidth -= last.width;
          }
          lines.push({
            items: currentItems,
            width: currentWidth,
            height: Math.max(maxFontSize, 10) * lineHeightFactor,
          });
          currentItems = [];
          currentWidth = 0;
          maxFontSize = 0;
        }
        if (subparts[s]) {
          const subWord = { ...word, text: subparts[s] };
          const w = measureWord(doc, subWord);
          currentItems.push({ ...subWord, width: w });
          currentWidth += w;
          if (subWord.size > maxFontSize) maxFontSize = subWord.size;
        }
      }
      continue;
    }

    const w = measureWord(doc, word);
    if (/^\s+$/.test(word.text)) {
      // Don't accumulate leading spaces on an empty line
      if (currentItems.length > 0) {
        currentItems.push({ ...word, width: w });
        currentWidth += w;
      }
      continue;
    }

    if (currentWidth + w > maxWidth && currentItems.length > 0) {
      // Trim trailing spaces before breaking to next line
      if (/^\s+$/.test(currentItems[currentItems.length - 1].text)) {
        const last = currentItems.pop()!;
        currentWidth -= last.width;
      }
      lines.push({
        items: currentItems,
        width: currentWidth,
        height: Math.max(maxFontSize, 10) * lineHeightFactor,
      });
      currentItems = [{ ...word, width: w }];
      currentWidth = w;
      maxFontSize = word.size;
    } else {
      currentItems.push({ ...word, width: w });
      currentWidth += w;
      if (word.size > maxFontSize) maxFontSize = word.size;
    }
  }

  if (currentItems.length > 0) {
    if (/^\s+$/.test(currentItems[currentItems.length - 1].text)) {
      const last = currentItems.pop()!;
      currentWidth -= last.width;
    }
    lines.push({
      items: currentItems,
      width: currentWidth,
      height: Math.max(maxFontSize, 10) * lineHeightFactor,
    });
  }

  return lines;
}

function renderStyledLines(
  doc: jsPDF,
  lines: StyledLine[],
  startX: number,
  startY: number,
  maxY: number,
  topMargin: number
): number {
  let y = startY;

  for (const line of lines) {
    if (y + line.height > maxY) {
      doc.addPage();
      y = topMargin;
    }

    let x = startX;
    for (const item of line.items) {
      if (item.isCode) {
        // Pill background for inline codespan
        doc.setFillColor(241, 245, 249); // slate-100
        doc.roundedRect(x - 1, y + 1.5, item.width + 2, line.height - 3, 1.5, 1.5, "F");
      }
      doc.setFont(item.font, item.style);
      doc.setFontSize(item.size);
      doc.setTextColor(item.color[0], item.color[1], item.color[2]);
      doc.text(item.text, x, y + line.height * 0.72);
      x += item.width;
    }

    y += line.height;
  }

  return y;
}

export function generateNotesPdfDoc(markdownNotes: string): jsPDF {
  const doc = new jsPDF({
    unit: "pt",
    format: "a4",
    orientation: "portrait",
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const leftMargin = 45;
  const rightMargin = 45;
  const topMargin = 48;
  const bottomMargin = 48;
  const contentWidth = pageWidth - leftMargin - rightMargin;
  const maxY = pageHeight - bottomMargin;

  let y = topMargin;

  // Document Title Header on Page 1
  const dateStr = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.setTextColor(15, 23, 42); // slate-900
  doc.text("Lecture Notes", leftMargin, y + 16);
  y += 24;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139); // slate-500
  doc.text(`Generated on ${dateStr} · LectureLogger`, leftMargin, y + 6);
  y += 14;

  // Header bottom border line
  doc.setDrawColor(226, 232, 240); // slate-200
  doc.setLineWidth(1);
  doc.line(leftMargin, y, leftMargin + contentWidth, y);
  y += 18;

  // Clean Markdown input to sanitize Unicode symbols and prevent jsPDF 16-bit encoding overlaps
  const sanitizedMarkdown = cleanPdfText(markdownNotes);
  const tokens = marked.lexer(sanitizedMarkdown);

  for (const token of tokens) {
    if (token.type === "space") {
      continue;
    }

    if (token.type === "heading") {
      const depth = token.depth;
      const headingFontSize = depth === 1 ? 17 : depth === 2 ? 13.5 : 11;
      const headingColor: [number, number, number] =
        depth === 1 ? [15, 23, 42] : depth === 2 ? [30, 41, 59] : [51, 65, 85];
      const spaceBefore = depth === 1 ? 16 : depth === 2 ? 14 : 10;
      const spaceAfter = depth === 1 ? 8 : depth === 2 ? 6 : 4;

      // Prevent heading orphans at the bottom of the page
      if (y + spaceBefore + headingFontSize + 35 > maxY) {
        doc.addPage();
        y = topMargin;
      } else {
        y += spaceBefore;
      }

      const words = extractStyledWords(token.tokens, headingFontSize, headingColor, "bold");
      const lines = wrapStyledWords(doc, words, contentWidth, 1.35);
      y = renderStyledLines(doc, lines, leftMargin, y, maxY, topMargin);

      if (depth <= 2) {
        doc.setDrawColor(241, 245, 249);
        doc.setLineWidth(0.75);
        doc.line(leftMargin, y + 2, leftMargin + contentWidth, y + 2);
      }

      y += spaceAfter;
    } else if (token.type === "paragraph") {
      const words = extractStyledWords(token.tokens, 10, [30, 41, 59], "normal");
      const lines = wrapStyledWords(doc, words, contentWidth, 1.45);
      y = renderStyledLines(doc, lines, leftMargin, y, maxY, topMargin);
      y += 6;
    } else if (token.type === "list") {
      const isOrdered = token.ordered;
      const startNum = typeof token.start === "number" ? token.start : 1;

      token.items.forEach((item: Tokens.ListItem | any, idx: number) => {
        const bulletText = isOrdered ? `${startNum + idx}. ` : "• ";
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10);
        const bulletWidth = Math.max(doc.getTextWidth(bulletText), 14);
        const itemContentWidth = contentWidth - bulletWidth - 4;

        // Render bullet prefix & text
        const itemWords = extractStyledWords(item.tokens, 10, [30, 41, 59], "normal");
        const lines = wrapStyledWords(doc, itemWords, itemContentWidth, 1.45);

        const firstLineHeight = lines[0]?.height || 14.5;
        if (y + firstLineHeight > maxY) {
          doc.addPage();
          y = topMargin;
        }

        doc.setFont("helvetica", "bold");
        doc.setFontSize(10);
        doc.setTextColor(71, 85, 105);
        doc.text(bulletText, leftMargin + 2, y + firstLineHeight * 0.72);

        y = renderStyledLines(doc, lines, leftMargin + bulletWidth + 4, y, maxY, topMargin);
        y += 3;
      });
      y += 4;
    } else if (token.type === "blockquote") {
      // AI enrichment blockquote
      const quoteWords: StyledWord[] = [];
      if (token.tokens) {
        for (const sub of token.tokens as any[]) {
          if (sub.type === "paragraph") {
            if (quoteWords.length > 0) {
              quoteWords.push({
                text: "\n\n",
                font: "helvetica",
                style: "normal",
                size: 9.5,
                color: [51, 65, 85],
              });
            }
            quoteWords.push(...extractStyledWords(sub.tokens, 9.5, [51, 65, 85], "normal"));
          } else if (sub.type === "text") {
            quoteWords.push(...extractStyledWords(sub.tokens || [sub], 9.5, [51, 65, 85], "normal"));
          }
        }
      } else if (token.text) {
        quoteWords.push({
          text: token.text,
          font: "helvetica",
          style: "normal",
          size: 9.5,
          color: [51, 65, 85],
        });
      }

      const innerPaddingX = 14;
      const innerPaddingY = 8;
      const boxWidth = contentWidth;
      const innerWidth = boxWidth - innerPaddingX - 10;
      const quoteLines = wrapStyledWords(doc, quoteWords, innerWidth, 1.4);
      const contentHeight = quoteLines.reduce((sum, l) => sum + l.height, 0);
      const totalBoxHeight = contentHeight + innerPaddingY * 2;

      if (y + totalBoxHeight > maxY) {
        if (totalBoxHeight < maxY - topMargin) {
          doc.addPage();
          y = topMargin;
        }
      }

      // Draw background container
      doc.setFillColor(248, 250, 252); // slate-50
      doc.setDrawColor(226, 232, 240); // slate-200
      doc.setLineWidth(0.5);
      doc.roundedRect(leftMargin, y, boxWidth, totalBoxHeight, 3, 3, "FD");

      // Draw left accent bar (indigo)
      doc.setFillColor(99, 102, 241); // indigo-500
      doc.rect(leftMargin, y, 3.5, totalBoxHeight, "F");

      // Render text inside
      const renderedEndY = renderStyledLines(
        doc,
        quoteLines,
        leftMargin + innerPaddingX,
        y + innerPaddingY,
        maxY,
        topMargin
      );

      y = Math.max(y + totalBoxHeight, renderedEndY + innerPaddingY) + 8;
    } else if (token.type === "code") {
      const codeLines = token.text.split("\n");
      const lineH = 12;
      const boxPadding = 8;
      const totalH = codeLines.length * lineH + boxPadding * 2;

      if (y + totalH > maxY) {
        if (totalH < maxY - topMargin) {
          doc.addPage();
          y = topMargin;
        }
      }

      doc.setFillColor(241, 245, 249); // slate-100
      doc.setDrawColor(226, 232, 240);
      doc.setLineWidth(0.5);
      doc.roundedRect(leftMargin, y, contentWidth, totalH, 3, 3, "FD");

      doc.setFont("courier", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(15, 23, 42);

      let codeY = y + boxPadding;
      for (const cl of codeLines) {
        if (codeY + lineH > maxY) {
          doc.addPage();
          codeY = topMargin;
        }
        doc.text(cl, leftMargin + boxPadding, codeY + lineH * 0.72);
        codeY += lineH;
      }

      y += totalH + 8;
    } else if (token.type === "hr") {
      y += 8;
      if (y > maxY) {
        doc.addPage();
        y = topMargin;
      }
      doc.setDrawColor(226, 232, 240);
      doc.setLineWidth(0.75);
      doc.line(leftMargin, y, leftMargin + contentWidth, y);
      y += 12;
    }
  }

  // Add Headers & Footers across all pages
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);

    // Running top header on pages 2+
    if (p > 1) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(148, 163, 184); // slate-400
      doc.text("Lecture Notes · LectureLogger", leftMargin, topMargin - 16);
      doc.setDrawColor(241, 245, 249);
      doc.setLineWidth(0.5);
      doc.line(leftMargin, topMargin - 10, leftMargin + contentWidth, topMargin - 10);
    }

    // Running bottom footer on all pages
    const footerY = pageHeight - 26;
    doc.setDrawColor(241, 245, 249);
    doc.setLineWidth(0.5);
    doc.line(leftMargin, footerY - 8, leftMargin + contentWidth, footerY - 8);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(148, 163, 184);
    doc.text("LectureLogger", leftMargin, footerY);

    const pageNumStr = `Page ${p} of ${totalPages}`;
    const pageNumWidth = doc.getTextWidth(pageNumStr);
    doc.text(pageNumStr, leftMargin + contentWidth - pageNumWidth, footerY);
  }

  return doc;
}

export async function downloadNotesAsPdf(markdownNotes: string, filename?: string): Promise<void> {
  const doc = generateNotesPdfDoc(markdownNotes);
  const name = filename || `lecturelogger-${new Date().toISOString().slice(0, 10)}.pdf`;
  doc.save(name);
}
