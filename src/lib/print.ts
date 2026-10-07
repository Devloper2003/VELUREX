/**
 * Velurex HMS — reliable print pipeline.
 *
 * Problem this solves: calling `window.print()` on the app shell prints the
 * whole SPA (navigation, sidebars, dialog chrome, dark theme) and the old
 * `visibility:hidden + position:fixed` hacks break inside Radix dialogs — a
 * transformed ancestor turns `position:fixed` into dialog-relative positioning
 * and the dialog's `max-h/overflow` clips the sheet, so invoices came out
 * truncated and covered in UI chrome.
 *
 * Fix: print a *standalone document* through a hidden, off-screen iframe.
 * The builder functions elsewhere (invoiceHtml, posBillHtml, kotPrintHtml,
 * daySummaryPrintHtml …) already produce complete styled HTML — this utility
 * just hands that exact document to the printer, untouched by app CSS.
 */

/** Escape text for use inside HTML attribute / <title> context. */
function escText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Wrap an HTML fragment in a minimal print shell; pass full documents through. */
function toFullDoc(html: string, title: string): string {
  if (/<!doctype\s+html|<html[\s>]/i.test(html)) return html;
  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>${escText(title)}</title>
<style>
  @page { margin: 12mm; }
  html, body { background: #fff !important; color: #1c2622;
    -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: Georgia, 'Times New Roman', serif; margin: 24px auto; max-width: 720px; padding: 0 12px; }
</style></head>
<body>${html}</body></html>`;
}

/**
 * Print `html` (a fragment or a full document) on the paper — nothing else.
 * Uses an off-screen iframe sized for real print layout (0×0 iframes clip in
 * some browsers), waits for the document to load, then triggers the dialog.
 * Safe to call repeatedly; the previous frame is replaced each time.
 */
export function printHtml(html: string, title = "Print"): void {
  if (typeof document === "undefined") return;

  // Replace any frame left over from a previous print.
  document.getElementById("vlx-print-frame")?.remove();

  const iframe = document.createElement("iframe");
  iframe.id = "vlx-print-frame";
  iframe.setAttribute("aria-hidden", "true");
  iframe.setAttribute("title", title);
  // Off-screen but with real dimensions — required for correct print layout.
  iframe.setAttribute(
    "style",
    "position:fixed;left:-10000px;top:0;width:840px;height:1100px;border:0;visibility:hidden;"
  );
  document.body.appendChild(iframe);

  const win = iframe.contentWindow;
  if (!win) {
    iframe.remove();
    return;
  }

  const doc = win.document;
  doc.open();
  doc.write(toFullDoc(html, title));
  doc.close();

  // Give layout/fonts a beat, then print. Keep the frame alive while the
  // dialog is open (Chrome drops the job if the frame is removed too early);
  // it is garbage-collected on the next call or after 60s.
  const fire = () => {
    try {
      win.focus();
      win.print();
    } finally {
      window.setTimeout(() => iframe.remove(), 60_000);
    }
  };

  if (doc.readyState === "complete") {
    window.setTimeout(fire, 250);
  } else {
    iframe.onload = () => window.setTimeout(fire, 250);
    // Fallback if onload never fires (cached empty doc edge cases).
    window.setTimeout(() => {
      if (document.getElementById("vlx-print-frame") === iframe && doc.readyState !== "complete") fire();
    }, 1500);
  }
}
