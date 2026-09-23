import "server-only";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { errors } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { formatBytes } from "@/lib/format/units";
import type { ReceiptView } from "@/server/receipts/service";
import { SIMULATION_STAMP_DEFAULT, WICORE_DISCLAIMER } from "@/server/receipts/service";

/** The Wicore notice, repeated on its own line so it cannot be missed. */
const WICORE_NOTICE = WICORE_DISCLAIMER;

/**
 * Receipt PDF renderer.
 *
 * Why a bundled TrueType font is involved at all: the base-14 PDF fonts are WinAnsi
 * only, and WinAnsi cannot encode Vietnamese. The brief requires the receipt to carry
 * the exact line "Biên lai mô phỏng – không phải chứng từ thanh toán chính thức của
 * Wicore." whenever the Wicore label is used, so Helvetica would silently drop the
 * glyphs that matter most. `DejaVuSans.ttf` (Bitstream Vera license, bundled with its
 * license text) is embedded instead, which also means every character the receipt can
 * show - including operator-supplied customer names - renders exactly as stored.
 *
 * Font resolution order, so the renderer works in dev, in a VPS checkout and in the
 * Docker image without any of them special-casing the others:
 *   1. RECEIPTS_FONT_PATH      (operator override)
 *   2. the bundled asset        (present in a repo checkout)
 *   3. common OS package paths  (present in most Linux images)
 *
 * If none is found the PDF is still produced with Helvetica, and a loud warning is
 * logged; the fallback path transliterates nothing, it simply cannot draw glyphs
 * outside WinAnsi, so `renderReceiptPdf` refuses rather than emitting a document that
 * is missing its mandatory disclaimer.
 */

const PAGE_WIDTH = 595.28; // A4 in points
const PAGE_HEIGHT = 841.89;
const MARGIN = 42;

const INK = rgb(0.07, 0.07, 0.08);
const MUTED = rgb(0.42, 0.42, 0.45);
const LINE = rgb(0.85, 0.85, 0.87);
const ACCENT = rgb(0.7, 0.1, 0.12);

const FONT_CANDIDATES = [
  process.env.RECEIPTS_FONT_PATH,
  join(process.cwd(), "src/server/receipts/assets/DejaVuSans.ttf"),
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
];

/** Returns the first readable Unicode-capable font, or null when none exists. */
function resolveFontBuffer(): Buffer | null {
  for (const candidate of FONT_CANDIDATES) {
    if (!candidate) continue;
    try {
      if (existsSync(candidate)) return readFileSync(candidate);
    } catch (error) {
      logger.warn("receipt font unreadable", { candidate, error });
    }
  }
  return null;
}

/** True when the text cannot be drawn by a WinAnsi base-14 font. */
function needsUnicodeFont(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[^\x00-\xFF]/.test(text);
}

interface DrawOptions {
  size?: number;
  color?: ReturnType<typeof rgb>;
  x?: number;
  maxWidth?: number;
}

/** Word-wraps text to `maxWidth` using the real font metrics, then draws the lines. */
function drawWrapped(
  page: PDFPage,
  font: PDFFont,
  text: string,
  y: number,
  options: DrawOptions = {},
): number {
  const size = options.size ?? 9;
  const color = options.color ?? INK;
  const x = options.x ?? MARGIN;
  const maxWidth = options.maxWidth ?? PAGE_WIDTH - MARGIN * 2;

  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);

  let cursor = y;
  for (const line of lines) {
    page.drawText(line, { x, y: cursor, size, font, color });
    cursor -= size * 1.4;
  }
  return cursor;
}

function drawRule(page: PDFPage, y: number): void {
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_WIDTH - MARGIN, y },
    thickness: 0.6,
    color: LINE,
  });
}

/** `label` on the left, `value` right-aligned, both on one baseline. */
function drawRow(
  page: PDFPage,
  font: PDFFont,
  label: string,
  value: string,
  y: number,
  options?: { valueColor?: ReturnType<typeof rgb>; size?: number },
): number {
  const size = options?.size ?? 9;
  const valueWidth = font.widthOfTextAtSize(value, size);
  page.drawText(label, { x: MARGIN, y, size, font, color: MUTED });
  page.drawText(value, {
    x: PAGE_WIDTH - MARGIN - valueWidth,
    y,
    size,
    font,
    color: options?.valueColor ?? INK,
  });
  return y - size * 1.65;
}

function heading(page: PDFPage, font: PDFFont, text: string, y: number): number {
  page.drawText(text.toUpperCase(), {
    x: MARGIN,
    y,
    size: 7.5,
    font,
    color: MUTED,
  });
  return y - 14;
}

const money = (value: number, currency: string): string =>
  `${currency} ${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/**
 * Renders one simulated receipt as a PDF.
 *
 * The numbers are read from the stored row only: this function receives a
 * `ReceiptView`, which itself is derived from the persisted calculation, so the PDF
 * cannot disagree with the dashboard, the CSV or the verification page.
 */
export async function renderReceiptPdf(receipt: ReceiptView): Promise<Uint8Array> {
  const fontBytes = resolveFontBuffer();

  if (!fontBytes) {
    // Refusing to emit a document whose mandatory disclaimer would be dropped is the
    // correct failure: a receipt that silently omits "not an official payment
    // document" is worse than no receipt.
    if (needsUnicodeFont(receipt.disclaimer) || needsUnicodeFont(receipt.customerName)) {
      throw errors.dependency(
        "No Unicode-capable font is available for receipt rendering. " +
          "Install a DejaVu Sans font or set RECEIPTS_FONT_PATH.",
      );
    }
    logger.warn("receipt PDF falling back to WinAnsi base-14 font");
  }

  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const font = fontBytes
    ? await document.embedFont(fontBytes)
    : await document.embedFont(StandardFonts.Helvetica);

  const page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  // ------------------------------------------------------------- banner -----
  const bannerText = "SIMULATED RECEIPT - NOT AN OFFICIAL PAYMENT DOCUMENT";
  const bannerWidth = font.widthOfTextAtSize(bannerText, 8);
  const bannerHeight = 20;
  page.drawRectangle({
    x: MARGIN,
    y: y - bannerHeight + 4,
    width: PAGE_WIDTH - MARGIN * 2,
    height: bannerHeight,
    borderWidth: 1,
    borderColor: ACCENT,
  });
  page.drawText(bannerText, {
    x: (PAGE_WIDTH - bannerWidth) / 2,
    y: y - bannerHeight + 11,
    size: 8,
    font,
    color: ACCENT,
  });
  y -= bannerHeight + 22;

  // ------------------------------------------------------------- title ------
  page.drawText("Receipt (simulated)", { x: MARGIN, y, size: 16, font, color: INK });
  const providerWidth = font.widthOfTextAtSize(receipt.providerLabel, 16);
  page.drawText(receipt.providerLabel, {
    x: PAGE_WIDTH - MARGIN - providerWidth,
    y,
    size: 16,
    font,
    color: MUTED,
  });
  y -= 20;

  page.drawText(`Receipt ID: ${receipt.receiptNumber}`, { x: MARGIN, y, size: 9.5, font, color: INK });
  y -= 13;
  page.drawText(`Generated: ${new Date(receipt.generatedAt).toISOString()}`, {
    x: MARGIN,
    y,
    size: 8.5,
    font,
    color: MUTED,
  });
  y -= 16;
  drawRule(page, y);
  y -= 18;

  // ---------------------------------------------------------- parties -------
  y = heading(page, font, "Parties and period", y);
  y = drawRow(page, font, "Customer", receipt.customerName, y);
  if (receipt.customerRef) y = drawRow(page, font, "Customer reference", receipt.customerRef, y);
  if (receipt.deviceLabel) y = drawRow(page, font, "Device", receipt.deviceLabel, y);
  if (receipt.configLabel) y = drawRow(page, font, "Configuration", receipt.configLabel, y);
  if (receipt.nodeLabel) y = drawRow(page, font, "VPN node", receipt.nodeLabel, y);
  y = drawRow(page, font, "Period start", receipt.periodStart, y);
  y = drawRow(page, font, "Period end", receipt.periodEnd, y);
  y = drawRow(page, font, "Status", receipt.status, y);
  y -= 6;
  drawRule(page, y);
  y -= 18;

  // ------------------------------------------------------------- data -------
  y = heading(page, font, "Data", y);
  y = drawRow(page, font, "Data used (before optimization)", formatBytes(BigInt(receipt.rawBytes)), y);
  y = drawRow(page, font, "Data carried (after optimization)", formatBytes(BigInt(receipt.optimizedBytes)), y);
  y = drawRow(page, font, "Saved", formatBytes(BigInt(receipt.savedBytes)), y);
  y = drawRow(page, font, "Savings", receipt.savingPct === null ? "Unavailable" : `${receipt.savingPct}%`, y, {
    valueColor: receipt.savingPct === null ? MUTED : INK,
  });
  y = drawRow(page, font, "Savings basis", receipt.savingsKind, y, {
    valueColor: receipt.savingsKind === "MEASURED" ? INK : MUTED,
  });
  y -= 6;
  drawRule(page, y);
  y -= 18;

  // ----------------------------------------------------------- pricing ------
  y = heading(page, font, "Pricing (simulated)", y);
  y = drawRow(page, font, "Price per GB", money(receipt.pricePerGb, receipt.currency), y);
  y = drawRow(page, font, "Base fee", money(receipt.baseFee, receipt.currency), y);
  y = drawRow(page, font, "Free quota", `${receipt.freeQuotaGb.toFixed(3)} GB`, y);
  y = drawRow(page, font, "Billable", `${receipt.billableGb.toFixed(3)} GB`, y);
  y = drawRow(page, font, "Subtotal", money(receipt.calculation.subtotal, receipt.currency), y);

  // The simulated total is the one number an operator checks first: give it weight.
  const totalLabel = "SIMULATED TOTAL";
  page.drawText(totalLabel, { x: MARGIN, y: y - 4, size: 9, font, color: MUTED });
  const totalValue = money(receipt.simulatedTotal, receipt.currency);
  const totalWidth = font.widthOfTextAtSize(totalValue, 13);
  page.drawText(totalValue, {
    x: PAGE_WIDTH - MARGIN - totalWidth,
    y: y - 6,
    size: 13,
    font,
    color: ACCENT,
  });
  y -= 26;

  page.drawText("Calculation", { x: MARGIN, y, size: 8, font, color: MUTED });
  y -= 12;
  y = drawWrapped(page, font, receipt.calculation.formula, y, { size: 8, color: INK });
  y -= 8;
  drawRule(page, y);
  y -= 18;

  // ---------------------------------------------------------- integrity -----
  y = heading(page, font, "Integrity and verification", y);
  y = drawRow(page, font, "Algorithm", "SHA-256 (canonical payload)", y);
  y = drawRow(page, font, "Verification hash", receipt.verificationHash, y);
  y -= 4;
  y = drawWrapped(page, font, receipt.verifyUrl, y, { size: 8, color: MUTED });
  y -= 12;

  // --------------------------------------------------------- notices --------
  y = heading(page, font, "Notices", y);
  y = drawWrapped(page, font, receipt.disclaimer, y, { size: 8, color: ACCENT });

  if (receipt.providerLabel.trim().toLowerCase().includes("wicore")) {
    y -= 6;
    y = drawWrapped(page, font, WICORE_NOTICE, y, { size: 9, color: ACCENT });
  }

  // ------------------------------------------------------------- stamp ------
  if (receipt.stampEnabled && y > 150) {
    const stampText = receipt.stampText ?? SIMULATION_STAMP_DEFAULT;
    const boxHeight = 74;
    y -= 18;
    page.drawRectangle({
      x: MARGIN,
      y: y - boxHeight,
      width: 260,
      height: boxHeight,
      borderWidth: 2,
      borderColor: ACCENT,
    });
    // Deliberately double-bordered and clearly worded so it can never be mistaken for
    // an official seal, a signature or a provider stamp.
    page.drawRectangle({
      x: MARGIN + 4,
      y: y - boxHeight + 4,
      width: 252,
      height: boxHeight - 8,
      borderWidth: 0.6,
      borderColor: ACCENT,
    });
    let stampY = y - 20;
    page.drawText("DEMO", { x: MARGIN + 14, y: stampY, size: 12, font, color: ACCENT });
    stampY -= 15;
    for (const line of wrapFixed(stampText, 232, font, 8)) {
      page.drawText(line, { x: MARGIN + 14, y: stampY, size: 8, font, color: ACCENT });
      stampY -= 11;
    }
    y = y - boxHeight - 6;
  }

  // ------------------------------------------------------------- footer -----
  const footY = 34;
  page.drawText(
    "Simulated document produced by the VWRAY control plane. No payment was processed.",
    { x: MARGIN, y: footY, size: 7.5, font, color: MUTED },
  );
  const pageLabel = "Page 1 of 1";
  page.drawText(pageLabel, {
    x: PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(pageLabel, 7.5),
    y: footY,
    size: 7.5,
    font,
    color: MUTED,
  });

  return document.save();
}

/** Wraps text without needing a baseline: used inside the stamp box. */
function wrapFixed(text: string, maxWidth: number, font: PDFFont, size: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !current) current = candidate;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}
