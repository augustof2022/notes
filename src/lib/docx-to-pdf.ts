import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb } from 'pdf-lib';

/**
 * Word (.docx) to PDF, on this device: mammoth reads the document's
 * structure (headings, paragraphs, lists, tables, pictures, bold/italic) and
 * this lays it out on Letter pages with real, selectable text. Page layout
 * is simplified: what matters is reading, highlighting and asking about it.
 */
const PAGE = { width: 612, height: 792, margin: 64 };
const BODY = 11, LEADING = 1.45;
const HEADINGS: Record<string, number> = { H1: 22, H2: 17, H3: 14, H4: 12.5, H5: 12, H6: 11.5 };
const INK = rgb(0.16, 0.15, 0.19), SOFT = rgb(0.42, 0.4, 0.46), RULE = rgb(0.82, 0.8, 0.85);

interface Run { text: string; bold: boolean; italic: boolean; link: boolean; br?: boolean }
interface Fonts { regular: PDFFont; bold: PDFFont; italic: PDFFont; boldItalic: PDFFont; unicode: () => Promise<PDFFont> }

export async function docxToPdf(data: ArrayBuffer): Promise<Uint8Array> {
  const mammoth = await import('mammoth');
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer: data });
  const body = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
  const pdf = await PDFDocument.create();
  let unicode: Promise<PDFFont> | null = null;
  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique), boldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
    // Words outside the basic Latin set use Liberation Sans (shipped with the board's fonts), embedded only when needed.
    unicode: () => unicode ||= (async () => {
      const fontkit = (await import('@pdf-lib/fontkit')).default; pdf.registerFontkit(fontkit);
      const bytes = await (await fetch(new URL(`${import.meta.env.BASE_URL}excalidraw/fonts/Liberation/LiberationSans-Regular.woff2`, location.href))).arrayBuffer();
      // Embedded whole: fontkit's subsetter cannot rewrite this WOFF2 font.
      return pdf.embedFont(bytes, { subset: false });
    })(),
  };
  const writer = new Writer(pdf, fonts);
  await writer.blocks(Array.from(body.children), 0);
  if (!pdf.getPageCount()) writer.page();
  return pdf.save();
}

class Writer {
  private current: PDFPage | null = null;
  private y = 0;
  private readonly right = PAGE.width - PAGE.margin;
  constructor(private pdf: PDFDocument, private fonts: Fonts) {}
  page() { this.current = this.pdf.addPage([PAGE.width, PAGE.height]); this.y = PAGE.height - PAGE.margin; return this.current; }
  private room(height: number) { if (!this.current || this.y - height < PAGE.margin) this.page(); return this.current!; }
  private gap(points: number) { if (this.current && this.y < PAGE.height - PAGE.margin) this.y -= points; }

  async blocks(nodes: Element[], indent: number) {
    for (const node of nodes) await this.block(node, indent);
  }
  private async block(node: Element, indent: number) {
    const tag = node.tagName;
    if (HEADINGS[tag]) { this.gap(HEADINGS[tag] * 0.7); await this.paragraph(runsOf(node, true), { size: HEADINGS[tag], indent }); this.gap(HEADINGS[tag] * 0.45); return; }
    if (tag === 'P') { for (const image of Array.from(node.querySelectorAll('img'))) await this.image(image, indent); await this.paragraph(runsOf(node), { size: BODY, indent }); this.gap(7); return; }
    if (tag === 'UL' || tag === 'OL') {
      let number = 1;
      for (const item of Array.from(node.children)) {
        if (item.tagName !== 'LI') continue;
        const nested = Array.from(item.children).filter(child => child.tagName === 'UL' || child.tagName === 'OL');
        const own = item.cloneNode(true) as Element; own.querySelectorAll('ul,ol').forEach(child => child.remove());
        await this.paragraph(runsOf(own), { size: BODY, indent: indent + 18, marker: tag === 'OL' ? `${number++}.` : '•' });
        this.gap(3);
        await this.blocks(nested, indent + 18);
      }
      this.gap(5); return;
    }
    if (tag === 'TABLE') { await this.table(node, indent); this.gap(9); return; }
    if (tag === 'BLOCKQUOTE') { await this.blocks(Array.from(node.children), indent + 18); return; }
    if (tag === 'IMG') { await this.image(node as HTMLImageElement, indent); return; }
    if (tag === 'HR') { const page = this.room(12); this.y -= 6; page.drawLine({ start: { x: PAGE.margin + indent, y: this.y }, end: { x: this.right, y: this.y }, thickness: 0.6, color: RULE }); this.y -= 6; return; }
    if (node.children.length) { await this.blocks(Array.from(node.children), indent); return; }
    const runs = runsOf(node);
    if (runs.some(run => run.text.trim())) { await this.paragraph(runs, { size: BODY, indent }); this.gap(7); }
  }

  /** Wraps runs into lines that fit `width`, keeping each word's style. */
  private async lines(runs: Run[], size: number, width: number) {
    type Piece = { text: string; font: PDFFont; width: number; link: boolean };
    const lines: Piece[][] = [[]]; let used = 0;
    for (const run of runs) {
      if (run.br) { lines.push([]); used = 0; continue; }
      for (const word of run.text.split(/(\s+)/)) {
        if (!word) continue;
        const text = /^\s+$/.test(word) ? ' ' : word;
        const font = await this.font(text, run.bold, run.italic);
        const measured = font.widthOfTextAtSize(text, size);
        if (text === ' ' && !lines.at(-1)!.length) continue;
        if (used + measured > width && lines.at(-1)!.length && text !== ' ') { lines.push([]); used = 0; }
        if (measured > width) {
          // A single word wider than the line is split by characters.
          let chunk = '';
          for (const char of text) {
            if (font.widthOfTextAtSize(chunk + char, size) > width && chunk) { lines.at(-1)!.push({ text: chunk, font, width: font.widthOfTextAtSize(chunk, size), link: run.link }); lines.push([]); chunk = ''; }
            chunk += char;
          }
          lines.at(-1)!.push({ text: chunk, font, width: font.widthOfTextAtSize(chunk, size), link: run.link }); used = lines.at(-1)!.reduce((sum, piece) => sum + piece.width, 0);
          continue;
        }
        lines.at(-1)!.push({ text, font, width: measured, link: run.link }); used += measured;
      }
    }
    for (const line of lines) while (line.at(-1)?.text === ' ') line.pop();
    return lines.filter((line, index) => line.length || index < lines.length - 1);
  }
  private async font(text: string, bold: boolean, italic: boolean) {
    const font = bold && italic ? this.fonts.boldItalic : bold ? this.fonts.bold : italic ? this.fonts.italic : this.fonts.regular;
    try { font.encodeText(text); return font; } catch { return this.fonts.unicode(); }
  }
  private async paragraph(runs: Run[], { size, indent, marker }: { size: number; indent: number; marker?: string }) {
    if (!runs.some(run => run.text.trim() || run.br)) return;
    const left = PAGE.margin + indent, lines = await this.lines(runs, size, this.right - left), height = size * LEADING;
    for (const [index, line] of lines.entries()) {
      const page = this.room(height); this.y -= height;
      if (marker && index === 0) page.drawText(marker, { x: left - 13, y: this.y + size * 0.3, size, font: this.fonts.regular, color: SOFT });
      let x = left;
      for (const piece of line) {
        if (piece.text !== ' ') page.drawText(piece.text, { x, y: this.y + size * 0.3, size, font: piece.font, color: piece.link ? rgb(0.33, 0.27, 0.72) : INK });
        x += piece.width;
      }
    }
  }
  private async table(node: Element, indent: number) {
    const rows = Array.from(node.querySelectorAll('tr'));
    const columns = Math.max(1, ...rows.map(row => row.children.length));
    const left = PAGE.margin + indent, width = (this.right - left) / columns, pad = 5, size = BODY - 1, height = size * LEADING;
    for (const row of rows) {
      const cells = await Promise.all(Array.from(row.children).map(async cell => this.lines(runsOf(cell, cell.tagName === 'TH'), size, width - pad * 2)));
      const rowHeight = Math.max(...cells.map(lines => lines.length), 1) * height + pad * 2;
      const page = this.room(Math.min(rowHeight, PAGE.height - PAGE.margin * 2));
      const top = this.y;
      cells.forEach((lines, column) => {
        const x = left + column * width;
        page.drawRectangle({ x, y: top - rowHeight, width, height: rowHeight, borderColor: RULE, borderWidth: 0.6 });
        lines.forEach((line, index) => {
          let at = x + pad;
          for (const piece of line) { if (piece.text !== ' ') page.drawText(piece.text, { x: at, y: top - pad - (index + 1) * height + size * 0.3, size, font: piece.font, color: INK }); at += piece.width; }
        });
      });
      this.y = top - rowHeight;
    }
  }
  private async image(node: HTMLImageElement, indent: number) {
    const embedded = await embedImage(this.pdf, node.getAttribute('src') || '');
    if (!embedded) return;
    const maxWidth = this.right - PAGE.margin - indent, maxHeight = PAGE.height - PAGE.margin * 2;
    const scale = Math.min(1, maxWidth / embedded.width, maxHeight / embedded.height);
    const width = embedded.width * scale, height = embedded.height * scale;
    const page = this.room(height + 6); this.y -= height;
    page.drawImage(embedded, { x: PAGE.margin + indent, y: this.y, width, height }); this.y -= 6;
  }
}

/** Words and their style, in order; `<br>` breaks a line. */
function runsOf(node: Node, bold = false, italic = false, link = false): Run[] {
  const runs: Run[] = [];
  node.childNodes.forEach(child => {
    if (child.nodeType === Node.TEXT_NODE) { const text = child.textContent?.replace(/\s+/g, ' ') || ''; if (text) runs.push({ text, bold, italic, link }); return; }
    if (!(child instanceof Element)) return;
    const tag = child.tagName;
    if (tag === 'BR') { runs.push({ text: '', bold, italic, link, br: true }); return; }
    if (tag === 'IMG' || tag === 'UL' || tag === 'OL' || tag === 'TABLE') return;
    runs.push(...runsOf(child, bold || tag === 'STRONG' || tag === 'B' || tag === 'TH', italic || tag === 'EM' || tag === 'I', link || tag === 'A'));
    if (tag === 'P' || tag === 'DIV') runs.push({ text: '', bold, italic, link, br: true });
  });
  return runs;
}

/** PNG and JPEG go in as they are; other picture types are redrawn as PNG. */
async function embedImage(pdf: PDFDocument, src: string): Promise<PDFImage | null> {
  const match = /^data:([^;,]+);base64,(.*)$/.exec(src);
  if (!match) return null;
  try {
    const bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0));
    if (match[1] === 'image/png') return await pdf.embedPng(bytes);
    if (match[1] === 'image/jpeg') return await pdf.embedJpg(bytes);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: match[1] }));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0); bitmap.close();
    const png = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    return png ? await pdf.embedPng(new Uint8Array(await png.arrayBuffer())) : null;
  } catch { return null; }
}
