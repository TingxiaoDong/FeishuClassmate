/**
 * 轻量办公文件读写（不引入第三方依赖，只用 Node 自带 zlib）：
 *   - ZIP 读 / 写（xlsx、docx 都是 zip）
 *   - XLSX 读第一张工作表（共享字符串、行内字符串、数字、布尔、日期格式）/ 写单张工作表
 *   - CSV 读（UTF-8、UTF-8 BOM、GBK 自动识别）/ 写（UTF-8 BOM，Excel 直接打开不乱码）
 *   - 图片尺寸（PNG / JPEG / GIF），PNG 解码为 RGB(+Alpha)（PDF 嵌图用）
 */
import { crc32, deflateRawSync, deflateSync, inflateRawSync, inflateSync } from 'node:zlib';

export class OfficeError extends Error {}

// ============================================================ ZIP

export function zipWrite(files: Array<{ name: string; data: Buffer | string }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const raw = typeof f.data === 'string' ? Buffer.from(f.data, 'utf8') : f.data;
    const comp = deflateRawSync(raw);
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(raw) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, end]);
}

export function zipRead(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new OfficeError('文件不是有效的 xlsx / docx（压缩包损坏）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new OfficeError('压缩包目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + elen + clen;
    total += usize;
    if (total > 300 * 1024 * 1024) throw new OfficeError('文件解压后太大');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data, { maxOutputLength: Math.max(usize, 1) + 1024 }));
  }
  return out;
}

// ============================================================ XML 工具

export const xmlEsc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
    // XML 1.0 不允许的控制字符
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

const xmlUnesc = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    return String.fromCodePoint(k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
  });

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlUnesc(m[1])).join('');

// ============================================================ 表格（二维字符串）

export type Sheet = string[][];

const colIndex = (ref: string) => {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};
const colName = (i: number) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 22, 45, 46, 47]);
/** Excel 序列日期 → YYYY-MM-DD（带时间时 YYYY-MM-DD HH:mm）。 */
function excelDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  const iso = new Date(ms).toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function readXlsx(buf: Buffer, maxRows = 100_000): Sheet {
  const z = zipRead(buf);
  const str = (n: string) => z.get(n)?.toString('utf8');
  // 第一张工作表
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = str('xl/workbook.xml');
  const rels = str('xl/_rels/workbook.xml.rels');
  const firstSheet = wb?.match(/<sheet\s[^>]*>/)?.[0];
  const rid = firstSheet && (attr(firstSheet, 'r:id') ?? attr(firstSheet, 'id'));
  if (rid && rels) {
    const rel = [...rels.matchAll(/<Relationship\s[^>]*>/g)].map((m) => m[0]).find((t) => attr(t, 'Id') === rid);
    const target = rel && attr(rel, 'Target');
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }
  const sheet = str(sheetPath);
  if (!sheet) throw new OfficeError('找不到工作表');
  const shared = [...(str('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
  // 日期格式
  const styles = str('xl/styles.xml') ?? '';
  const customDate = new Set<number>();
  for (const m of styles.matchAll(/<numFmt\s[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId'));
    const code = xmlUnesc(attr(m[0], 'formatCode') ?? '').replace(/"[^"]*"|\[[^\]]*\]/g, '');
    if (/[yd]/i.test(code) || /m{1,2}.*d|d.*m/i.test(code)) customDate.add(id);
  }
  const xfs = [...(styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? '').matchAll(/<xf\s[^>]*?\/?>/g)].map((m) => Number(attr(m[0], 'numFmtId') ?? 0));
  const isDateStyle = (s?: string) => {
    if (s === undefined) return false;
    const f = xfs[Number(s)];
    return f !== undefined && (BUILTIN_DATE_FMTS.has(f) || customDate.has(f));
  };

  const rows: Sheet = [];
  for (const rm of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    if (rows.length >= maxRows) break;
    const rIdx = Number(attr(rm[0], 'r') ?? rows.length + 1) - 1;
    const row: string[] = [];
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = `<c${cm[1]}>`;
      const ref = attr(tag, 'r');
      const ci = ref ? colIndex(ref) : row.length;
      const t = attr(tag, 't');
      const inner = cm[2] ?? '';
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let val = '';
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = texts(inner);
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (t === 'str' || t === 'e') val = xmlUnesc(v ?? '');
      else if (v !== undefined) {
        const n = Number(v);
        val = isDateStyle(attr(tag, 's')) && Number.isFinite(n) ? excelDate(n) : xmlUnesc(v);
      }
      while (row.length < ci) row.push('');
      row[ci] = val;
    }
    while (rows.length < rIdx) rows.push([]);
    rows[rIdx] = row;
  }
  return trimSheet(rows);
}

export function writeXlsx(rows: Sheet, sheetName = 'Sheet1'): Buffer {
  const cell = (v: string, r: number, c: number) => {
    const ref = `${colName(c)}${r + 1}`;
    const style = r === 0 ? ' s="1"' : '';
    if (v === '') return '';
    if (r > 0 && /^-?\d{1,15}(\.\d+)?$/.test(v) && !/^0\d/.test(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
  };
  const body = rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => cell(v ?? '', r, c)).join('')}</row>`).join('');
  const width = Math.max(1, ...rows.map((r) => r.length));
  const cols = `<cols><col min="1" max="${width}" width="18" customWidth="1"/></cols>`;
  const safeName = xmlEsc(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1');
  return zipWrite([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${safeName}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="等线"/></font><font><b/><sz val="11"/><name val="等线"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>' },
    { name: 'xl/worksheets/sheet1.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${body}</sheetData></worksheet>` },
  ]);
}

/** 去掉末尾空行、每行末尾空格子。 */
function trimSheet(rows: Sheet): Sheet {
  const out = rows.map((r) => (r ?? []).map((v) => v ?? ''));
  while (out.length && out[out.length - 1].every((v) => !v.trim())) out.pop();
  return out;
}

// ============================================================ CSV

/** UTF-8（含 BOM）优先，不是合法 UTF-8 时按 GBK 解。 */
export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('gbk').decode(buf);
  }
}

export function readCsv(buf: Buffer, maxRows = 100_000): Sheet {
  const s = decodeText(buf);
  // 分隔符：逗号为主，第一行没有逗号而有制表符时按 TSV
  const firstLine = s.slice(0, s.indexOf('\n') >= 0 ? s.indexOf('\n') : s.length);
  const sep = !firstLine.includes(',') && firstLine.includes('\t') ? '\t' : ',';
  const rows: Sheet = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"' && cur === '') quoted = true;
    else if (ch === sep) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
      if (rows.length >= maxRows) return trimSheet(rows);
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return trimSheet(rows);
}

export function writeCsv(rows: Sheet): Buffer {
  const esc = (v: string) => {
    // 防公式注入：以 = + - @ 开头的文本加单引号
    const safe = /^[=+\-@]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? `'${v}` : v;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(rows.map((r) => r.map((v) => esc(v ?? '')).join(',')).join('\r\n'), 'utf8')]);
}

/** 按文件名后缀 / 内容读成二维表。 */
export function readSheetFile(buf: Buffer, fileName: string): Sheet {
  const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  if (/\.xlsx$/i.test(fileName) || isZip) return readXlsx(buf);
  if (/\.xls$/i.test(fileName)) throw new OfficeError('不支持旧版 .xls，请在 Excel 里另存为 .xlsx 或 .csv');
  return readCsv(buf);
}

// ============================================================ 图片

export interface ImageInfo { type: 'png' | 'jpeg' | 'gif'; width: number; height: number }

export function imageInfo(b: Buffer): ImageInfo | undefined {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { type: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 10 && b.toString('latin1', 0, 3) === 'GIF') return { type: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) return undefined;
      const marker = b[p + 1];
      const len = b.readUInt16BE(p + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { type: 'jpeg', height: b.readUInt16BE(p + 5), width: b.readUInt16BE(p + 7) };
      }
      p += 2 + len;
    }
  }
  return undefined;
}

/** JPEG 的颜色分量数（1 灰度 / 3 RGB / 4 CMYK）。 */
export function jpegComponents(b: Buffer): number {
  let p = 2;
  while (p + 9 < b.length) {
    const marker = b[p + 1];
    const len = b.readUInt16BE(p + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return b[p + 9];
    p += 2 + len;
  }
  return 3;
}

/** PNG（8 位，非隔行）解码为 RGB 像素（deflate 后）+ 可选 Alpha（deflate 后）。不支持的返回 undefined。 */
export function pngToRaw(b: Buffer): { width: number; height: number; colors: 1 | 3; rgb: Buffer; alpha?: Buffer } | undefined {
  const width = b.readUInt32BE(16), height = b.readUInt32BE(20);
  const depth = b[24], ctype = b[25], interlace = b[28];
  if (depth !== 8 || interlace !== 0 || width * height > 25_000_000) return undefined;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ctype];
  if (!channels) return undefined;
  const idat: Buffer[] = [];
  let palette: Buffer | undefined, trns: Buffer | undefined;
  for (let p = 8; p + 8 <= b.length; ) {
    const len = b.readUInt32BE(p);
    const type = b.toString('latin1', p + 4, p + 8);
    const data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : undefined;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;
      const up = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      out[x] = v & 0xff;
    }
  }
  const n = width * height;
  if (ctype === 0) return { width, height, colors: 1, rgb: deflateSync(px) };
  if (ctype === 2) return { width, height, colors: 3, rgb: deflateSync(px) };
  if (ctype === 4) {
    const g = Buffer.alloc(n), al = Buffer.alloc(n);
    for (let i = 0; i < n; i++) { g[i] = px[i * 2]; al[i] = px[i * 2 + 1]; }
    return { width, height, colors: 1, rgb: deflateSync(g), alpha: deflateSync(al) };
  }
  const rgb = Buffer.alloc(n * 3);
  let al: Buffer | undefined;
  if (ctype === 6) {
    al = Buffer.alloc(n);
    for (let i = 0; i < n; i++) { rgb[i * 3] = px[i * 4]; rgb[i * 3 + 1] = px[i * 4 + 1]; rgb[i * 3 + 2] = px[i * 4 + 2]; al[i] = px[i * 4 + 3]; }
  } else {
    if (!palette) return undefined;
    if (trns) al = Buffer.alloc(n, 255);
    for (let i = 0; i < n; i++) {
      const idx = px[i];
      rgb[i * 3] = palette[idx * 3] ?? 0; rgb[i * 3 + 1] = palette[idx * 3 + 1] ?? 0; rgb[i * 3 + 2] = palette[idx * 3 + 2] ?? 0;
      if (al && trns) al[i] = trns[idx] ?? 255;
    }
  }
  return { width, height, colors: 3, rgb: deflateSync(rgb), ...(al ? { alpha: deflateSync(al) } : {}) };
}
