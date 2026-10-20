/**
 * 文档导出（迭代 5 R-DC-06）：Markdown → DOCX / PDF，正文里的 cos-file:// 图片一起导出。
 *
 * PDF 用阅读器内置的中文字体 STSong-Light（Adobe-GB1，不嵌入字体文件），所以文件很小、无需服务器装字体；
 * 图片支持 JPEG、PNG（含透明）；其他格式写成「[图片：说明]」占位。
 * DOCX 支持标题、段落、粗体 / 斜体 / 行内代码、有序 / 无序列表、引用、代码块、表格、分隔线、图片。
 */
import { deflateSync } from 'node:zlib';
import { imageInfo, jpegComponents, pngToRaw, xmlEsc, zipWrite } from './office.js';

export interface Run { text: string; bold?: boolean; italic?: boolean; code?: boolean }
export type Block =
  | { kind: 'h'; level: number; runs: Run[] }
  | { kind: 'p'; runs: Run[] }
  | { kind: 'li'; runs: Run[]; ordered: boolean; n: number; depth: number }
  | { kind: 'quote'; runs: Run[] }
  | { kind: 'code'; text: string }
  | { kind: 'img'; key: string; alt: string }
  | { kind: 'hr' }
  | { kind: 'table'; rows: Run[][][] };

const IMG_RE = /!\[([^\]]*)\]\(cos-file:\/\/([A-Za-z0-9_\-.]+)[^)]*\)/g;

/** 行内：**粗** __粗__ *斜* _斜_ `代码` [文字](链接) ~~删~~ 其他图片 → 文字。 */
export function parseInline(s: string): Run[] {
  const out: Run[] = [];
  const re = /(\*\*|__)(.+?)\1|(\*|_)([^*_]+?)\3|`([^`]+)`|!\[([^\]]*)\]\([^)]*\)|\[([^\]]+)\]\(([^)]+)\)|~~(.+?)~~/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index! > last) out.push({ text: s.slice(last, m.index) });
    if (m[2] !== undefined) out.push(...parseInline(m[2]).map((r) => ({ ...r, bold: true })));
    else if (m[4] !== undefined) out.push({ text: m[4], italic: true });
    else if (m[5] !== undefined) out.push({ text: m[5], code: true });
    else if (m[6] !== undefined) out.push({ text: m[6] ? `[图片：${m[6]}]` : '[图片]' });
    else if (m[7] !== undefined) out.push({ text: /^https?:/.test(m[8]) && m[8] !== m[7] ? `${m[7]}（${m[8]}）` : m[7] });
    else if (m[9] !== undefined) out.push({ text: m[9] });
    last = m.index! + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out.map((r) => ({ ...r, text: r.text.replace(/\\([\\`*_{}[\]()#+\-.!>])/g, '$1') })).filter((r) => r.text);
}

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) pushText(para.join(' '), (runs) => blocks.push({ kind: 'p', runs }));
    para = [];
  };
  /** 文本里夹着的图片拆成单独的图片块。 */
  const pushText = (text: string, emit: (runs: Run[]) => void) => {
    let last = 0;
    for (const m of text.matchAll(IMG_RE)) {
      const before = text.slice(last, m.index).trim();
      if (before) emit(parseInline(before));
      blocks.push({ kind: 'img', alt: m[1], key: m[2] });
      last = m.index! + m[0].length;
    }
    const rest = text.slice(last).trim();
    if (rest) emit(parseInline(rest));
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      flush();
      const buf: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) buf.push(lines[i]);
      blocks.push({ kind: 'code', text: buf.join('\n') });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { flush(); blocks.push({ kind: 'h', level: h[1].length, runs: parseInline(h[2]) }); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); blocks.push({ kind: 'hr' }); continue; }
    const li = line.match(/^(\s*)([-*+]|(\d+)[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/);
    if (li) {
      flush();
      const check = li[4] !== undefined ? (li[4].trim() ? '☑ ' : '☐ ') : '';
      pushText(check + li[5], (runs) => blocks.push({ kind: 'li', runs, ordered: !!li[3], n: Number(li[3] ?? 0), depth: Math.min(4, Math.floor(li[1].replace(/\t/g, '  ').length / 2)) }));
      continue;
    }
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) { flush(); pushText(q[1], (runs) => blocks.push({ kind: 'quote', runs })); continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => parseInline(c.trim()));
      const rows = [cells(line)];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      blocks.push({ kind: 'table', rows });
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

const plain = (runs: Run[]) => runs.map((r) => r.text).join('');

// ============================================================ DOCX

export async function toDocx(title: string, blocks: Block[], loadImage: (key: string) => Promise<Buffer | undefined>): Promise<Buffer> {
  const media: Array<{ name: string; data: Buffer; rid: string }> = [];
  const runXml = (r: Run) => {
    const pr = `${r.bold ? '<w:b/>' : ''}${r.italic ? '<w:i/>' : ''}${r.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:shd w:val="clear" w:fill="F2F3F5"/>' : ''}`;
    return `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEsc(r.text)}</w:t></w:r>`;
  };
  const para = (runs: Run[], ppr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${runs.map(runXml).join('')}</w:p>`;
  const parts: string[] = [para([{ text: title }], '<w:pStyle w:val="Title"/>')];
  let imgN = 0;
  for (const b of blocks) {
    if (b.kind === 'h') parts.push(para(b.runs, `<w:pStyle w:val="Heading${Math.min(b.level, 3)}"/>`));
    else if (b.kind === 'p') parts.push(para(b.runs));
    else if (b.kind === 'li') parts.push(para([{ text: b.ordered ? `${b.n}. ` : '• ' }, ...b.runs], `<w:ind w:left="${420 + b.depth * 420}" w:hanging="300"/>`));
    else if (b.kind === 'quote') parts.push(para(b.runs.map((r) => ({ ...r, italic: true })), '<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="C9CDD4"/></w:pBdr><w:ind w:left="300"/>'));
    else if (b.kind === 'code') {
      for (const l of b.text.split('\n')) parts.push(para([{ text: l || ' ', code: true }], '<w:spacing w:after="0"/><w:shd w:val="clear" w:fill="F2F3F5"/>'));
    } else if (b.kind === 'hr') parts.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="C9CDD4"/></w:pBdr></w:pPr></w:p>');
    else if (b.kind === 'table') {
      const cols = Math.max(...b.rows.map((r) => r.length));
      const rows = b.rows.map((r, ri) => `<w:tr>${Array.from({ length: cols }, (_, c) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${para((r[c] ?? []).map((x) => (ri === 0 ? { ...x, bold: true } : x)))}</w:tc>`).join('')}</w:tr>`).join('');
      parts.push(`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="C9CDD4"/><w:left w:val="single" w:sz="4" w:color="C9CDD4"/><w:bottom w:val="single" w:sz="4" w:color="C9CDD4"/><w:right w:val="single" w:sz="4" w:color="C9CDD4"/><w:insideH w:val="single" w:sz="4" w:color="C9CDD4"/><w:insideV w:val="single" w:sz="4" w:color="C9CDD4"/></w:tblBorders></w:tblPr>${rows}</w:tbl>`, '<w:p/>');
    } else if (b.kind === 'img') {
      const data = await loadImage(b.key);
      const info = data && imageInfo(data);
      if (!data || !info) { parts.push(para([{ text: b.alt ? `[图片：${b.alt}]` : '[图片]' }])); continue; }
      imgN++;
      const ext = info.type === 'jpeg' ? 'jpeg' : info.type;
      const rid = `rIdImg${imgN}`;
      media.push({ name: `image${imgN}.${ext}`, data, rid });
      const maxW = 5_760_720; // 6.3 英寸
      let cx = info.width * 9525, cy = info.height * 9525;
      if (cx > maxW) { cy = Math.round((cy * maxW) / cx); cx = maxW; }
      parts.push(`<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${imgN}" name="图片 ${imgN}" descr="${xmlEsc(b.alt)}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${imgN}" name="image${imgN}.${ext}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`);
    }
  }
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${parts.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1300" w:bottom="1440" w:left="1300" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const heading = (id: string, name: string, sz: number, outline: number) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/>${outline >= 0 ? `<w:outlineLvl w:val="${outline}"/>` : ''}</w:pPr><w:rPr><w:b/><w:sz w:val="${sz}"/></w:rPr></w:style>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体"/><w:sz w:val="22"/><w:lang w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${heading('Title', 'Title', 40, -1)}${heading('Heading1', 'heading 1', 32, 0)}${heading('Heading2', 'heading 2', 28, 1)}${heading('Heading3', 'heading 3', 24, 2)}<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style></w:styles>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${media.map((m) => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join('')}</Relationships>`;
  return zipWrite([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: doc },
    { name: 'word/styles.xml', data: styles },
    { name: 'word/_rels/document.xml.rels', data: rels },
    ...media.map((m) => ({ name: `word/media/${m.name}`, data: m.data })),
  ]);
}

// ============================================================ PDF

const PAGE_W = 595.28, PAGE_H = 841.89, MARGIN = 56;
const CONTENT_W = PAGE_W - MARGIN * 2;

/** STSong-Light：ASCII（CID 1–95）半角 500，其他全角 1000。 */
const NO_LINE_START = new Set([...'。，、；：？！）」』”’》〉】…—．,.;:?!)]}%']);
const charW = (ch: string) => (ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) <= 0x7e ? 0.5 : 1);
const hex = (s: string) => {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    out += (cp > 0xffff || cp < 0x20 ? 0x3f : cp).toString(16).padStart(4, '0');
  }
  return `<${out}>`;
};

interface Img { name: string; obj: number; w: number; h: number }

export async function toPdf(title: string, blocks: Block[], loadImage: (key: string) => Promise<Buffer | undefined>): Promise<Buffer> {
  const objs: Array<Buffer | string> = [];
  const add = (o: Buffer | string) => { objs.push(o); return objs.length; };
  const stream = (dict: string, data: Buffer) => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]);

  const catalogId = add(''), pagesId = add('');
  const fontId = add('');
  const cidId = add('<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor ' + (objs.length + 2) + ' 0 R /DW 1000 /W [1 95 500] >>');
  objs[fontId - 1] = `<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [${cidId} 0 R] >>`;
  add('<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>');

  const pages: string[][] = [];
  const pageImgs: Img[][] = [];
  let ops: string[] = [];
  let imgs: Img[] = [];
  let y = 0;
  const newPage = () => { ops = []; imgs = []; pages.push(ops); pageImgs.push(imgs); y = PAGE_H - MARGIN; };
  newPage();
  const ensure = (h: number) => { if (y - h < MARGIN) newPage(); };

  /** 按宽度折行（拉丁单词尽量不拆）。 */
  const wrap = (text: string, size: number, width: number): string[] => {
    const lines: string[] = [];
    for (const para of text.split('\n')) {
      let line = '', w = 0, lastSpace = -1;
      for (const ch of para) {
        const cw = charW(ch) * size;
        // 行首禁则：中文收尾标点不放到行首，挂在上一行末尾
        if (w + cw > width && line && NO_LINE_START.has(ch) && w + cw <= width + size) { line += ch; w += cw; continue; }
        if (w + cw > width && line) {
          if (lastSpace > 0 && charW(ch) === 0.5 && ch !== ' ') {
            lines.push(line.slice(0, lastSpace));
            line = line.slice(lastSpace + 1);
          } else { lines.push(line); line = ''; }
          w = [...line].reduce((s, c) => s + charW(c) * size, 0);
          lastSpace = -1;
          if (ch === ' ' && !line) continue;
        }
        if (ch === ' ') lastSpace = line.length;
        line += ch; w += cw;
      }
      lines.push(line);
    }
    return lines;
  };

  const text = (s: string, opt: { size: number; x?: number; width?: number; bold?: boolean; gray?: boolean; lead?: number; bg?: boolean; dot?: boolean }) => {
    const x = opt.x ?? MARGIN;
    const lead = opt.size * (opt.lead ?? 1.6);
    let first = true;
    for (const l of wrap(s, opt.size, opt.width ?? CONTENT_W - (x - MARGIN))) {
      ensure(lead);
      y -= lead;
      if (opt.dot && first) {
        // 列表圆点直接画（• 不在 GB 字库里）
        const r = opt.size * 0.16, cx = x - opt.size * 0.7, cy = y + opt.size * 0.33, k = r * 0.5523;
        ops.push(`0.12 0.13 0.14 rg ${(cx + r).toFixed(2)} ${cy.toFixed(2)} m ${(cx + r).toFixed(2)} ${(cy + k).toFixed(2)} ${(cx + k).toFixed(2)} ${(cy + r).toFixed(2)} ${cx.toFixed(2)} ${(cy + r).toFixed(2)} c ${(cx - k).toFixed(2)} ${(cy + r).toFixed(2)} ${(cx - r).toFixed(2)} ${(cy + k).toFixed(2)} ${(cx - r).toFixed(2)} ${cy.toFixed(2)} c ${(cx - r).toFixed(2)} ${(cy - k).toFixed(2)} ${(cx - k).toFixed(2)} ${(cy - r).toFixed(2)} ${cx.toFixed(2)} ${(cy - r).toFixed(2)} c ${(cx + k).toFixed(2)} ${(cy - r).toFixed(2)} ${(cx + r).toFixed(2)} ${(cy - k).toFixed(2)} ${(cx + r).toFixed(2)} ${cy.toFixed(2)} c f`);
      }
      first = false;
      if (opt.bg) ops.push(`0.95 0.95 0.96 rg ${MARGIN - 4} ${(y - opt.size * 0.35).toFixed(2)} ${CONTENT_W + 8} ${lead.toFixed(2)} re f`);
      ops.push(`BT ${opt.gray ? '0.4 0.4 0.4' : '0.12 0.13 0.14'} rg ${opt.bold ? '2 Tr 0.35 w 0.12 0.13 0.14 RG' : '0 Tr'} /F1 ${opt.size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td ${hex(l)} Tj ET`);
    }
  };
  const gap = (h: number) => { y -= h; if (y < MARGIN) newPage(); };
  const runsBold = (runs: Run[]) => runs.length > 0 && runs.every((r) => r.bold);

  text(title, { size: 22, bold: true, lead: 1.4 });
  gap(10);
  let imgN = 0;
  for (const b of blocks) {
    if (b.kind === 'h') { gap(6); text(plain(b.runs), { size: [0, 18, 15, 13, 12, 11, 11][b.level], bold: true, lead: 1.5 }); gap(2); }
    else if (b.kind === 'p') { text(plain(b.runs), { size: 11, bold: runsBold(b.runs) }); gap(4); }
    else if (b.kind === 'li') {
      const x = MARGIN + 14 + b.depth * 16;
      if (b.ordered) text(`${b.n}. ${plain(b.runs)}`, { size: 11, x });
      else text(plain(b.runs), { size: 11, x: x + 8, dot: true });
    } else if (b.kind === 'quote') { text(plain(b.runs), { size: 11, x: MARGIN + 14, gray: true }); gap(4); }
    else if (b.kind === 'code') { text(b.text || ' ', { size: 9.5, bg: true, lead: 1.5 }); gap(6); }
    else if (b.kind === 'hr') { ensure(14); y -= 7; ops.push(`0.8 0.8 0.83 RG 0.6 w ${MARGIN} ${y.toFixed(2)} m ${PAGE_W - MARGIN} ${y.toFixed(2)} l S`); y -= 7; }
    else if (b.kind === 'table') {
      for (const [ri, row] of b.rows.entries()) text(row.map(plain).join('  |  '), { size: 10, bold: ri === 0 });
      gap(6);
    } else if (b.kind === 'img') {
      const data = await loadImage(b.key);
      const info = data && imageInfo(data);
      let id: number | undefined;
      if (data && info?.type === 'jpeg') {
        const comps = jpegComponents(data);
        const cs = comps === 1 ? '/DeviceGray' : comps === 4 ? '/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]' : '/DeviceRGB';
        id = add(stream(`/Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode`, data));
      } else if (data && info?.type === 'png') {
        const raw = pngToRaw(data);
        if (raw) {
          const smask = raw.alpha ? add(stream(`/Type /XObject /Subtype /Image /Width ${raw.width} /Height ${raw.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, raw.alpha)) : undefined;
          id = add(stream(`/Type /XObject /Subtype /Image /Width ${raw.width} /Height ${raw.height} /ColorSpace ${raw.colors === 1 ? '/DeviceGray' : '/DeviceRGB'} /BitsPerComponent 8 /Filter /FlateDecode${smask ? ` /SMask ${smask} 0 R` : ''}`, raw.rgb));
        }
      }
      if (!id || !info) { text(b.alt ? `[图片：${b.alt}]` : '[图片]', { size: 10, gray: true }); continue; }
      let w = info.width * 0.75, h = info.height * 0.75;
      const maxH = PAGE_H - MARGIN * 2 - 20;
      if (w > CONTENT_W) { h = (h * CONTENT_W) / w; w = CONTENT_W; }
      if (h > maxH) { w = (w * maxH) / h; h = maxH; }
      ensure(h + 8);
      y -= h + 4;
      const name = `Im${++imgN}`;
      imgs.push({ name, obj: id, w, h });
      ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${MARGIN} ${y.toFixed(2)} cm /${name} Do Q`);
      y -= 6;
    }
  }

  const kids: number[] = [];
  for (const [i, p] of pages.entries()) {
    const footer = `BT 0.6 0.6 0.6 rg 0 Tr /F1 9 Tf ${(PAGE_W / 2 - 10).toFixed(2)} 30 Td ${hex(`${i + 1} / ${pages.length}`)} Tj ET`;
    const content = add(stream('/Filter /FlateDecode', deflateSync(Buffer.from([...p, footer].join('\n'), 'latin1'))));
    const xo = pageImgs[i].length ? ` /XObject << ${pageImgs[i].map((m) => `/${m.name} ${m.obj} 0 R`).join(' ')} >>` : '';
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontId} 0 R >>${xo} >> /Contents ${content} 0 R >>`));
  }
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  objs[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  const info = add(`<< /Title ${hex(title)} /Producer (ClassmateOS) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`);

  const chunks: Buffer[] = [Buffer.from('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = chunks[0].length;
  const xref: number[] = [];
  for (const [i, o] of objs.entries()) {
    xref.push(offset);
    const body = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), typeof o === 'string' ? Buffer.from(o, 'latin1') : o, Buffer.from('\nendobj\n', 'latin1')]);
    chunks.push(body);
    offset += body.length;
  }
  const xrefStr = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${xref.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(Buffer.from(xrefStr, 'latin1'));
  return Buffer.concat(chunks);
}
