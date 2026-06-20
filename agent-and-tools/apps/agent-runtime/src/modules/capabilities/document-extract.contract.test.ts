import assert from "assert";
import { extractKnowledgeText } from "./document-extract";
import { ValidationError } from "../../shared/errors";

function u16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value, 0);
  return b;
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value, 0);
  return b;
}

function zipStore(entries: Array<{ name: string; content: string }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const content = Buffer.from(entry.content);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(content.length), u32(content.length), u16(name.length), u16(0), name, content,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(content.length), u32(content.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name,
    ]);
    localParts.push(local);
    centralParts.push(central);
    offset += local.length;
  }
  const local = Buffer.concat(localParts);
  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(central.length), u32(local.length), u16(0),
  ]);
  return Buffer.concat([local, central, end]);
}

async function main() {
  const docx = await extractKnowledgeText({
    originalname: "agent-brief.docx",
    mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: zipStore([{ name: "word/document.xml", content: "<w:document><w:t>Word agent brief</w:t></w:document>" }]),
  });
  assert(docx.includes("Word agent brief"));

  const pptx = await extractKnowledgeText({
    originalname: "runbook.pptx",
    mimetype: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: zipStore([{ name: "ppt/slides/slide1.xml", content: "<p:sld><a:t>Slide source rule</a:t></p:sld>" }]),
  });
  assert(pptx.includes("Slide source rule"));

  const xlsx = await extractKnowledgeText({
    originalname: "matrix.xlsx",
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: zipStore([{ name: "xl/sharedStrings.xml", content: "<sst><si><t>Spreadsheet skill row</t></si></sst>" }]),
  });
  assert(xlsx.includes("Spreadsheet skill row"));

  await assert.rejects(
    () => extractKnowledgeText({ originalname: "image.png", mimetype: "image/png", buffer: Buffer.from("png") }),
    (err) => err instanceof ValidationError && /Unsupported knowledge file type/.test(err.message) && err.status === 400,
  );

  console.log("document extraction contract tests passed");
}

void main();
