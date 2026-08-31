import { jsPDF } from "jspdf";
import { marked } from "marked";

export async function downloadNotesAsPdf(markdownNotes: string) {
  const htmlContent = await marked.parse(markdownNotes);

  const container = document.createElement("div");
  container.className = "pdf-export-container";
  container.style.position = "fixed";
  container.style.left = "-9999px";
  container.style.top = "0";
  container.style.width = "750px";
  container.style.padding = "32px 40px";
  container.style.backgroundColor = "#ffffff";
  container.style.color = "#0f172a";
  container.style.fontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
  container.style.fontSize = "14px";
  container.style.lineHeight = "1.65";

  const dateStr = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  container.innerHTML = `
    <style>
      .pdf-export-container * { box-sizing: border-box; }
      .pdf-header { margin-bottom: 24px; padding-bottom: 12px; border-bottom: 2px solid #e2e8f0; }
      .pdf-header h1 { margin: 0 0 6px 0; font-size: 24px; font-weight: 700; color: #0f172a; }
      .pdf-header .pdf-date { font-size: 12px; color: #64748b; font-weight: 500; }
      .pdf-export-container h2 { font-size: 18px; font-weight: 700; color: #1e293b; margin-top: 24px; margin-bottom: 10px; border-bottom: 1px solid #f1f5f9; padding-bottom: 4px; break-after: avoid; }
      .pdf-export-container h3 { font-size: 15px; font-weight: 600; color: #334155; margin-top: 18px; margin-bottom: 8px; break-after: avoid; }
      .pdf-export-container p { margin: 0 0 10px 0; color: #334155; }
      .pdf-export-container ul, .pdf-export-container ol { margin: 0 0 12px 0; padding-left: 24px; color: #334155; }
      .pdf-export-container li { margin-bottom: 6px; }
      .pdf-export-container strong { color: #0f172a; font-weight: 600; }
      .pdf-export-container blockquote {
        margin: 14px 0;
        padding: 10px 14px;
        background-color: #f8fafc;
        border-left: 4px solid #6366f1;
        border-radius: 4px;
        color: #334155;
        font-size: 13.5px;
        break-inside: avoid;
      }
      .pdf-export-container blockquote p { margin: 0; }
      .pdf-export-container code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        background-color: #f1f5f9;
        padding: 2px 5px;
        border-radius: 4px;
        font-size: 12.5px;
        color: #0f172a;
      }
      .pdf-export-container hr {
        border: 0;
        border-top: 1px solid #e2e8f0;
        margin: 20px 0;
      }
    </style>
    <div class="pdf-header">
      <h1>Lecture Notes</h1>
      <div class="pdf-date">Generated on ${dateStr} · LectureLogger</div>
    </div>
    <div class="pdf-body">
      ${htmlContent}
    </div>
  `;

  document.body.appendChild(container);

  try {
    const doc = new jsPDF({
      unit: "pt",
      format: "a4",
      orientation: "portrait",
    });

    await doc.html(container, {
      callback: (pdf) => {
        const filename = `lecturelogger-${new Date().toISOString().slice(0, 10)}.pdf`;
        pdf.save(filename);
      },
      x: 20,
      y: 20,
      width: 555,
      windowWidth: 750,
      autoPaging: "text",
    });
  } finally {
    document.body.removeChild(container);
  }
}
