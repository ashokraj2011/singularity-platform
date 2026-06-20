import { inflateRawSync } from "zlib";
import { ValidationError } from "../../shared/errors";
// pdf-parse ships a CommonJS bundle whose root index.js triggers test code
// when imported without a file path. Importing the lib subpath skips that.
// @ts-expect-error — sub-path has no bundled types; we type the call shape locally below.
import pdfParse from "pdf-parse/lib/pdf-parse.js";

type PdfParseFn = (data: Buffer) => Promise<{ text?: string }>;
const pdfExtract = pdfParse as unknown as PdfParseFn;

export type UploadedKnowledgeFile = {
  originalname: string;
  mimetype?: string;
  buffer: Buffer;
};

type ZipEntry = {
  name: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

function readUInt16(buffer: Buffer, offset: number): number {
  return buffer.readUInt16LE(offset);
}

function readUInt32(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 66_000);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (readUInt32(buffer, i) === 0x06054b50) return i;
  }
  throw new Error("invalid zip: central directory not found");
}

function listZipEntries(buffer: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  const count = readUInt16(buffer, eocd + 10);
  let offset = readUInt32(buffer, eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (readUInt32(buffer, offset) !== 0x02014b50) break;
    const compression = readUInt16(buffer, offset + 10);
    const compressedSize = readUInt32(buffer, offset + 20);
    const uncompressedSize = readUInt32(buffer, offset + 24);
    const nameLen = readUInt16(buffer, offset + 28);
    const extraLen = readUInt16(buffer, offset + 30);
    const commentLen = readUInt16(buffer, offset + 32);
    const localHeaderOffset = readUInt32(buffer, offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    entries.push({ name, compression, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localHeaderOffset;
  if (readUInt32(buffer, offset) !== 0x04034b50) throw new Error(`invalid zip local header: ${entry.name}`);
  const nameLen = readUInt16(buffer, offset + 26);
  const extraLen = readUInt16(buffer, offset + 28);
  const dataStart = offset + 30 + nameLen + extraLen;
  const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.compression === 0) return raw;
  if (entry.compression === 8) return inflateRawSync(raw, { finishFlush: 2 });
  throw new Error(`unsupported zip compression ${entry.compression}`);
}

function xmlToText(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractOfficeXml(buffer: Buffer, include: (name: string) => boolean): string {
  const entries = listZipEntries(buffer).filter((entry) => include(entry.name));
  const chunks: string[] = [];
  for (const entry of entries) {
    if (entry.uncompressedSize > 10_000_000) continue;
    const content = readZipEntry(buffer, entry).toString("utf8");
    const text = xmlToText(content);
    if (text) chunks.push(text);
  }
  return chunks.join("\n\n").trim();
}

export async function extractKnowledgeText(file: UploadedKnowledgeFile): Promise<string> {
  const name = file.originalname;
  const mime = file.mimetype ?? "";
  if (
    mime === "text/plain" ||
    mime === "text/markdown" ||
    /\.(txt|md|markdown)$/i.test(name)
  ) {
    return file.buffer.toString("utf8").trim();
  }
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) {
    const parsed = await pdfExtract(file.buffer);
    return (parsed.text ?? "").trim();
  }
  if (/\.docx$/i.test(name) || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return extractOfficeXml(file.buffer, (entry) => /^word\/document\.xml$/.test(entry) || /^word\/header\d*\.xml$/.test(entry) || /^word\/footer\d*\.xml$/.test(entry));
  }
  if (/\.pptx$/i.test(name) || mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
    return extractOfficeXml(file.buffer, (entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry) || /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(entry));
  }
  if (/\.xlsx$/i.test(name) || mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    return extractOfficeXml(file.buffer, (entry) => /^xl\/sharedStrings\.xml$/.test(entry) || /^xl\/worksheets\/sheet\d+\.xml$/.test(entry));
  }
  throw new ValidationError(
    `Unsupported knowledge file type: ${mime || "unknown"}`,
    { fileName: name, supported: supportedKnowledgeFileHint() },
  );
}

export function supportedKnowledgeFileHint(): string {
  return ".txt, .md, .pdf, .docx, .xlsx, .pptx";
}
