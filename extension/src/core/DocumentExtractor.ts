import * as fs from 'fs';
import * as zlib from 'zlib';
import * as path from 'path';

const MAX_CHARS = 12000;

export class DocumentExtractor {
  static extractBuffer(buffer: Buffer, name: string): { text: string; name: string } {
    const ext = path.extname(name).toLowerCase().slice(1);

    let text: string;
    switch (ext) {
      case 'xml':  text = extractXml(buffer);  break;
      case 'docx': text = extractDocx(buffer); break;
      case 'pdf':  text = extractPdf(buffer);  break;
      default:     text = buffer.toString('utf-8');
    }

    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS) + `\n\n[... troncato a ${MAX_CHARS} caratteri ...]`;
    }

    return { text, name };
  }

  static extract(filePath: string): { text: string; name: string } {
    const name = path.basename(filePath);
    const buffer = fs.readFileSync(filePath);
    return DocumentExtractor.extractBuffer(buffer, name);
  }
}

function extractXml(buffer: Buffer): string {
  return buffer.toString('utf-8');
}

function extractDocx(buffer: Buffer): string {
  const TARGET = 'word/document.xml';
  let pos = 0;

  while (pos + 30 < buffer.length) {
    if (buffer.readUInt32LE(pos) !== 0x04034b50) { pos++; continue; }

    const method       = buffer.readUInt16LE(pos + 8);
    const compSize     = buffer.readUInt32LE(pos + 18);
    const nameLen      = buffer.readUInt16LE(pos + 26);
    const extraLen     = buffer.readUInt16LE(pos + 28);
    const name         = buffer.slice(pos + 30, pos + 30 + nameLen).toString('utf-8');
    const dataStart    = pos + 30 + nameLen + extraLen;

    if (name === TARGET) {
      const raw = buffer.slice(dataStart, dataStart + compSize);
      const xml = method === 0 ? raw : zlib.inflateRawSync(raw);
      return cleanDocxXml(xml.toString('utf-8'));
    }

    const next = dataStart + compSize;
    pos = next > dataStart ? next : dataStart + 1;
  }

  throw new Error('File DOCX non valido o protetto da password');
}

function cleanDocxXml(xml: string): string {
  return xml
    .replace(/<w:p[ >][^>]*>/gi, '\n')
    .replace(/<w:tab\/>/gi, '\t')
    .replace(/<w:br\/>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractPdf(buffer: Buffer): string {
  const text = buffer.toString('latin1');
  const results: string[] = [];

  const btRegex  = /BT\s([\s\S]*?)\sET/g;
  const tjRegex  = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*(?:Tj|TJ|'|")/g;
  const arrRegex = /\[([^\]]*)\]\s*TJ/g;

  let btMatch: RegExpExecArray | null;
  while ((btMatch = btRegex.exec(text)) !== null) {
    const block = btMatch[1];

    tjRegex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = tjRegex.exec(block)) !== null) {
      const s = decodePdfStr(m[1]);
      if (s.trim()) results.push(s);
    }

    arrRegex.lastIndex = 0;
    while ((m = arrRegex.exec(block)) !== null) {
      const parts = m[1].match(/\(([^)\\]*(?:\\.[^)\\]*)*)\)/g) || [];
      for (const p of parts) {
        const s = decodePdfStr(p.slice(1, -1));
        if (s.trim()) results.push(s);
      }
    }
  }

  const out = results.join(' ').replace(/\s+/g, ' ').trim();
  return out || '[PDF non leggibile: contiene solo immagini o testo in formato non estraibile. Copia il testo manualmente e incollalo qui.]';
}

function decodePdfStr(s: string): string {
  return s
    .replace(/\\n/g, '\n').replace(/\\r/g, '').replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\');
}
