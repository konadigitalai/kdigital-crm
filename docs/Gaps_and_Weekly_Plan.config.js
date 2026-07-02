module.exports = {
  pdf_options: {
    format: "A4",
    margin: "20mm 18mm 22mm 18mm",
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: `<div style="font-size:8px;color:#888;width:100%;padding:0 18mm;display:flex;justify-content:space-between;">
      <span>Digital Edify Agentic CRM — Gaps & 12-Week Plan</span>
      <span class="date"></span>
    </div>`,
    footerTemplate: `<div style="font-size:8px;color:#888;width:100%;padding:0 18mm;display:flex;justify-content:space-between;">
      <span>Internal · Stakeholder Review</span>
      <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
    </div>`,
  },
  stylesheet_encoding: "utf-8",
  css: `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');
    body {
      font-family: 'Inter', ui-sans-serif, system-ui, sans-serif;
      font-size: 10.5pt;
      line-height: 1.6;
      color: #1f2937;
      max-width: 100%;
    }
    h1 {
      font-size: 26pt;
      color: #111827;
      border-bottom: 3px solid #6366f1;
      padding-bottom: 10px;
      margin-top: 4px;
      letter-spacing: -0.01em;
      font-weight: 800;
    }
    h2 {
      font-size: 16pt;
      color: #1e1b4b;
      margin-top: 28px;
      border-bottom: 1px solid #e5e7eb;
      padding-bottom: 6px;
      font-weight: 700;
    }
    h3 {
      font-size: 12.5pt;
      color: #312e81;
      margin-top: 20px;
      font-weight: 700;
    }
    h4 {
      font-size: 11pt;
      color: #4338ca;
      margin-top: 14px;
      font-weight: 600;
    }
    p, li { color: #1f2937; }
    strong { color: #111827; font-weight: 700; }
    code, pre, kbd, samp {
      font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 9pt;
    }
    code {
      background: #f1f5f9;
      padding: 1px 5px;
      border-radius: 4px;
    }
    pre code { background: transparent; padding: 0; }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 14px 0;
      page-break-inside: avoid;
      font-size: 9.5pt;
    }
    th, td {
      border: 1px solid #d1d5db;
      padding: 7px 10px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: #eef2ff;
      color: #1e1b4b;
      font-weight: 700;
    }
    tr:nth-child(even) td { background: #f9fafb; }
    /* Highlight the # column in gap tables and the Wk column in plan table */
    table th:first-child, table td:first-child {
      text-align: center;
      font-weight: 600;
      color: #4338ca;
      width: 4em;
    }
    blockquote {
      border-left: 4px solid #6366f1;
      background: #eef2ff;
      margin: 14px 0;
      padding: 10px 16px;
      color: #312e81;
      border-radius: 0 6px 6px 0;
      font-style: normal;
    }
    blockquote strong { color: #312e81; }
    a { color: #4338ca; text-decoration: none; border-bottom: 1px dotted #a5b4fc; }
    hr { border: none; border-top: 1px dashed #cbd5e1; margin: 24px 0; }
    h1, h2, h3, h4 { page-break-after: avoid; }
    table, pre, blockquote { page-break-inside: avoid; }
  `,
  marked_options: {
    gfm: true,
    headerIds: true,
  },
  body_class: "gaps-plan",
  launch_options: {
    args: ["--no-sandbox"],
  },
};
