import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOGO = [path.resolve(here, '../../assets/logo.jpg'), path.resolve(here, '../assets/logo.jpg')].find(existsSync);
const NAVY = '#0A2C5C';
const GOLD = '#DE9C3B';

function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

function header(doc: PDFKit.PDFDocument, title: string, subtitle?: string) {
  if (LOGO) doc.image(LOGO, 50, 36, { height: 48 });
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(16).text(title, 160, 44, { align: 'right' });
  if (subtitle) doc.fillColor('#555').font('Helvetica').fontSize(9).text(subtitle, 160, 64, { align: 'right' });
  doc.moveTo(50, 98).lineTo(545, 98).strokeColor(GOLD).lineWidth(1.5).stroke();
  doc.fillColor('#111').font('Helvetica').fontSize(10.5);
  doc.y = 114;
  doc.x = 50;
}

function footer(doc: PDFKit.PDFDocument, text: string) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.fillColor('#777').fontSize(7.5).text(`${text} · Page ${i + 1} of ${range.count}`, 50, 800, { width: 495, align: 'center', lineBreak: false });
  }
}

/** Locked agreement PDF with the signature record embedded (FR-PLC-13). */
export async function agreementPdf(input: {
  title: string;
  reference: string;
  version: number;
  body: string;
  signature?: { name: string; at: string; method: string; ip?: string | null; hash?: string };
}): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, info: { Title: input.title, Author: 'BTBG' } });
  header(doc, input.title, `Ref ${input.reference} · Version ${input.version}`);
  // The first paragraph is the template's title, already printed in the header.
  for (const para of input.body.split(/\n{2,}/).slice(1)) {
    doc.font('Helvetica').text(para, { align: 'left', lineGap: 2 });
    doc.moveDown(0.6);
  }
  doc.moveDown(1);
  doc.font('Helvetica-Bold').fillColor(NAVY).text('Electronic signature');
  doc.font('Helvetica').fillColor('#111');
  if (input.signature) {
    doc.text(`Signed by ${input.signature.name} on ${input.signature.at} by ${input.signature.method}.`);
    if (input.signature.ip) doc.text(`Signer network address: ${input.signature.ip}`);
    if (input.signature.hash) doc.fontSize(8).fillColor('#555').text(`Content fingerprint (SHA-256): ${input.signature.hash}`);
  } else {
    doc.text('Not yet signed. Sign in the BTBG app with the one-time code sent to your phone.');
  }
  footer(doc, `BTBG · ${input.reference} v${input.version}`);
  return collect(doc);
}

export async function certificatePdf(input: {
  name: string; programme: string; outcome: string | null; issuedAt: string; code: string; verifyUrl: string; ncMapping?: string | null;
}): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 40 });
  doc.rect(20, 20, 801, 555).lineWidth(3).strokeColor(NAVY).stroke();
  doc.rect(28, 28, 785, 539).lineWidth(1).strokeColor(GOLD).stroke();
  if (LOGO) doc.image(LOGO, 340, 50, { height: 90 });
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(30).text('Certificate of Completion', 0, 170, { align: 'center' });
  doc.fillColor('#333').font('Helvetica').fontSize(13).text('This certifies that', { align: 'center' });
  doc.moveDown(0.5).fillColor(NAVY).font('Helvetica-Bold').fontSize(26).text(input.name, { align: 'center' });
  doc.moveDown(0.5).fillColor('#333').font('Helvetica').fontSize(13)
    .text(`has completed the BTBG apprenticeship programme: ${input.programme}`, { align: 'center' });
  if (input.outcome) doc.text(`Outcome: ${input.outcome}`, { align: 'center' });
  if (input.ncMapping) doc.text(`Mapped to: ${input.ncMapping}`, { align: 'center' });
  doc.moveDown().text(`Issued on ${input.issuedAt}`, { align: 'center' });
  const qr = await QRCode.toBuffer(input.verifyUrl, { margin: 1, width: 220, color: { dark: NAVY } });
  doc.image(qr, 690, 420, { width: 105 });
  doc.fontSize(9).fillColor('#555').text(`Verify: ${input.verifyUrl}`, 50, 520, { width: 620 });
  doc.text(`Code: ${input.code}`, 50, 534);
  return collect(doc);
}

export async function payslipPdf(input: {
  name: string; period: string; payDate: string; lines: Array<{ kind: string; label: string; amount: number }>;
  gross: number; deductions: number; adjustments: number; net: number; bankLast4: string | null;
}): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
  header(doc, 'Payslip', `${input.period} · paid ${input.payDate}`);
  doc.font('Helvetica-Bold').text(input.name).font('Helvetica').text('Employer: Bey Tsub Bey Gay (BTBG)');
  if (input.bankLast4) doc.text(`Paid to account ending ${input.bankLast4}`);
  doc.moveDown();
  table(doc, ['Item', 'Type', 'Amount (Nu)'], input.lines.map((l) => [l.label, l.kind, money(l.amount)]), [260, 120, 115]);
  doc.moveDown();
  for (const [k, v] of [['Gross', input.gross], ['Deductions', -input.deductions], ['Adjustments', input.adjustments], ['Net pay', input.net]] as const) {
    doc.font(k === 'Net pay' ? 'Helvetica-Bold' : 'Helvetica').text(`${k}: Nu ${money(v)}`, { align: 'right' });
  }
  footer(doc, 'BTBG payslip');
  return collect(doc);
}

export async function invoicePdf(input: {
  number: string; org: string; period: string; issueDate: string | null; dueDate: string | null;
  lines: Array<{ type: string; description: string; amount: number }>; total: number; paid: number;
}): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
  header(doc, `Invoice ${input.number}`, `Period ${input.period}`);
  doc.font('Helvetica-Bold').text(`Bill to: ${input.org}`).font('Helvetica');
  doc.text(`Issued: ${input.issueDate ?? '-'}    Due: ${input.dueDate ?? '-'}`);
  doc.moveDown();
  table(doc, ['Part', 'Description', 'Amount (Nu)'], input.lines.map((l) => [l.type, l.description, money(l.amount)]), [80, 300, 115]);
  doc.moveDown();
  doc.font('Helvetica-Bold').text(`Total: Nu ${money(input.total)}`, { align: 'right' });
  doc.font('Helvetica').text(`Paid: Nu ${money(input.paid)}    Balance: Nu ${money(input.total - input.paid)}`, { align: 'right' });
  doc.moveDown().fontSize(9).fillColor('#555').text('Pay by bank transfer, cash or cheque to BTBG, quoting the invoice number.');
  footer(doc, `BTBG invoice ${input.number}`);
  return collect(doc);
}

/** Generic tabular report export (FR-ADM-06). */
export async function reportPdf(title: string, sections: Array<{ heading: string; columns: string[]; rows: Array<Array<string | number>> }>) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
  header(doc, title, `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  for (const s of sections) {
    if (doc.y > 700) doc.addPage();
    doc.font('Helvetica-Bold').fillColor(NAVY).fontSize(12).text(s.heading).fillColor('#111').fontSize(9.5);
    doc.moveDown(0.3);
    const w = Math.floor(495 / s.columns.length);
    table(doc, s.columns, s.rows.map((r) => r.map(String)), s.columns.map(() => w));
    doc.moveDown();
  }
  footer(doc, title);
  return collect(doc);
}

function table(doc: PDFKit.PDFDocument, cols: string[], rows: string[][], widths: number[]) {
  const x0 = 50;
  const draw = (cells: string[], bold: boolean) => {
    const y = doc.y;
    let x = x0;
    const heights = cells.map((c, i) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').heightOfString(c, { width: widths[i] - 6 }));
    const h = Math.max(...heights, 12) + 6;
    if (y + h > 780) {
      doc.addPage();
      return draw(cells, bold);
    }
    if (bold) doc.rect(x0, y - 2, widths.reduce((a, b) => a + b, 0), h).fill('#EEF2F8').fillColor('#111');
    cells.forEach((c, i) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').text(c, x + 3, y + 2, { width: widths[i] - 6 });
      x += widths[i];
    });
    doc.y = y + h;
    doc.x = x0;
  };
  draw(cols, true);
  for (const r of rows) draw(r, false);
}

export const money = (n: number) => Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
