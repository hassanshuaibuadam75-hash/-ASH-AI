// #ash Mesh — Office document writers (DOCX / XLSX / PPTX).
//
// These produce real Office Open XML packages. The ZIP container is written with Node's
// own zlib (deflate) instead of pulling in a document library, so the runtime image gains
// no extra dependency and no extra supply-chain surface, and the deployed container can
// export Office files without ffmpeg/ImageMagick or any network access.
//
// Every builder returns a Buffer. A file is only reported to the user after it exists on
// disk with a non-zero size; nothing here fabricates a "generated" document.
import zlib from 'node:zlib';

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export const OFFICE_FORMATS = {
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext: 'docx',
    label: 'Word document (.docx)',
  },
  xlsx: {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: 'xlsx',
    label: 'Excel workbook (.xlsx)',
  },
  pptx: {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ext: 'pptx',
    label: 'PowerPoint presentation (.pptx)',
  },
};

export function isOfficeFormat(format) {
  return Object.prototype.hasOwnProperty.call(OFFICE_FORMATS, String(format || '').toLowerCase());
}

/* ------------------------------ zip container ----------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

// A fixed timestamp keeps generated packages byte-stable, which makes them easy to
// compare in tests. 2026-11-21 00:00:00 in MS-DOS date/time format.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (11 << 5) | 21;

/** Build a ZIP archive from { name, data } entries. */
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // no extra field
    name.copy(local, 30);
    locals.push(local, deflated);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + deflated.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, end]);
}

/* -------------------------------- utilities ------------------------------- */

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Control characters are illegal in XML 1.0 and make Word/PowerPoint refuse the file.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function contentTypes(overrides) {
  return `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    overrides.map((o) => `<Override PartName="${o.part}" ContentType="${o.type}"/>`).join('') +
    '</Types>';
}

function rootRels(target) {
  return `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/>` +
    '</Relationships>';
}

/* ---------------------------------- DOCX ---------------------------------- */

function docxBody({ title, content }) {
  const paragraphs = [];
  const para = (text, { bold = false, size = null, colour = null } = {}) => {
    const runProps = [bold ? '<w:b/>' : '', size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : '',
      colour ? `<w:color w:val="${colour}"/>` : ''].join('');
    paragraphs.push(
      `<w:p><w:r>${runProps ? `<w:rPr>${runProps}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`
    );
  };

  if (title) para(title, { bold: true, size: 36, colour: '0A6B3D' });

  const lines = String(content ?? '').replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      paragraphs.push('<w:p/>');
      continue;
    }
    if (/^#{1,3}\s+/.test(trimmed)) {
      para(trimmed.replace(/^#{1,3}\s+/, ''), { bold: true, size: 30 });
    } else if (/^[-*\u2022]\s+/.test(trimmed)) {
      para(`\u2022 ${trimmed.replace(/^[-*\u2022]\s+/, '')}`);
    } else {
      para(trimmed);
    }
  }
  if (!paragraphs.length) paragraphs.push('<w:p/>');
  return paragraphs.join('');
}

export function buildDocx({ title, content }) {
  const document = `${XML_HEAD}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${docxBody({ title, content })}` +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>' +
    '</w:sectPr></w:body></w:document>';

  return buildZip([
    { name: '[Content_Types].xml', data: contentTypes([{ part: '/word/document.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' }]) },
    { name: '_rels/.rels', data: rootRels('word/document.xml') },
    { name: 'word/document.xml', data: document },
  ]);
}

/* ---------------------------------- XLSX ---------------------------------- */

function columnName(index) {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function sheetCell(value, ref) {
  const text = value == null ? '' : String(value);
  const numeric = typeof value === 'number' ? Number.isFinite(value) : /^-?\d+(\.\d+)?$/.test(text.trim()) && text.trim() !== '';
  if (numeric) return `<c r="${ref}"><v>${esc(String(value).trim())}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
}

/** rows: array of arrays (strings/numbers). A leading header row is rendered bold. */
export function buildXlsx({ title, rows }) {
  const clean = (Array.isArray(rows) ? rows : []).slice(0, 5000).map((row) => (Array.isArray(row) ? row : [row]));
  const body = clean.map((row, rowIndex) => {
    const cells = row.slice(0, 64).map((value, colIndex) => sheetCell(value, `${columnName(colIndex)}${rowIndex + 1}`)).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');
  const width = Math.max(1, ...clean.map((row) => row.length));

  const sheet = `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="A1:${columnName(width - 1)}${Math.max(1, clean.length)}"/>` +
    '<sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
    `<sheetData>${body}</sheetData></worksheet>`;

  const sheetName = (title || 'Sheet1').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1';
  const workbook = `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const workbookRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '</Relationships>';

  return buildZip([
    {
      name: '[Content_Types].xml',
      data: contentTypes([
        { part: '/xl/workbook.xml', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml' },
        { part: '/xl/worksheets/sheet1.xml', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml' },
      ]),
    },
    { name: '_rels/.rels', data: rootRels('xl/workbook.xml') },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
}

/* ---------------------------------- PPTX ---------------------------------- */

const P_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

const SLIDE_CX = 12192000;
const SLIDE_CY = 6858000;

function groupShapeTree(shapes) {
  return '<p:spTree>' +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    shapes +
    '</p:spTree>';
}

function textShape({ id, name, x, y, cx, cy, paragraphs }) {
  return '<p:sp><p:nvSpPr>' +
    `<p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/>` +
    '</p:nvSpPr><p:spPr>' +
    `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
    '</p:spPr><p:txBody><a:bodyPr wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>' +
    paragraphs +
    '</p:txBody></p:sp>';
}

function headingParagraph(text) {
  return '<a:p><a:pPr algn="l"/><a:r><a:rPr lang="en-US" sz="3200" b="1">' +
    '<a:solidFill><a:srgbClr val="00FF88"/></a:solidFill></a:rPr>' +
    `<a:t>${esc(text)}</a:t></a:r></a:p>`;
}

function bulletParagraph(text) {
  return '<a:p><a:pPr marL="285750" indent="-285750"><a:buFont typeface="Arial"/><a:buChar char="\u2022"/></a:pPr>' +
    '<a:r><a:rPr lang="en-US" sz="1800"/><a:t>' + esc(text) + '</a:t></a:r></a:p>';
}

const THEME = `${XML_HEAD}<a:theme ${P_NS} name="ash">` +
  '<a:themeElements><a:clrScheme name="ash">' +
  '<a:dk1><a:srgbClr val="04120C"/></a:dk1><a:lt1><a:srgbClr val="EAF7EF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="0B2A1B"/></a:dk2><a:lt2><a:srgbClr val="C9E8D6"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="00FF88"/></a:accent1><a:accent2><a:srgbClr val="1FA97A"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="7BD8A9"/></a:accent3><a:accent4><a:srgbClr val="FFD479"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="8AB4F8"/></a:accent5><a:accent6><a:srgbClr val="F28B82"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="8AB4F8"/></a:hlink><a:folHlink><a:srgbClr val="C58AF9"/></a:folHlink>' +
  '</a:clrScheme><a:fontScheme name="ash">' +
  '<a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
  '</a:fontScheme><a:fmtScheme name="ash">' +
  '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
  '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
  '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
  '<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>' +
  '</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';

const SLIDE_MASTER = `${XML_HEAD}<p:sldMaster ${P_NS}><p:cSld>` + groupShapeTree('') + '</p:cSld>' +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ' +
  'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>';

const SLIDE_MASTER_RELS = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
  '</Relationships>';

const SLIDE_LAYOUT = `${XML_HEAD}<p:sldLayout ${P_NS} type="blank" preserve="1"><p:cSld name="Blank">` +
  groupShapeTree('') + '</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

const SLIDE_LAYOUT_RELS = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>' +
  '</Relationships>';

function slideXml(slide) {
  const heading = textShape({
    id: 2, name: 'Title',
    x: 838200, y: 609600, cx: SLIDE_CX - 1676400, cy: 1143000,
    paragraphs: headingParagraph(slide.heading || ''),
  });
  const bullets = (Array.isArray(slide.bullets) ? slide.bullets : []).slice(0, 8);
  const bodyShape = bullets.length
    ? textShape({
      id: 3, name: 'Content',
      x: 838200, y: 2000000, cx: SLIDE_CX - 1676400, cy: SLIDE_CY - 2600000,
      paragraphs: bullets.map((b) => bulletParagraph(b)).join(''),
    })
    : '';
  return `${XML_HEAD}<p:sld ${P_NS}><p:cSld>` + groupShapeTree(heading + bodyShape) +
    '</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
}

const SLIDE_RELS = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
  '</Relationships>';

/**
 * slides: [{ heading, bullets: [] }]. A title slide is added first when a title is given.
 */
export function buildPptx({ title, slides }) {
  const list = (Array.isArray(slides) ? slides : []).slice(0, 15)
    .map((slide) => ({ heading: String(slide?.heading ?? ''), bullets: Array.isArray(slide?.bullets) ? slide.bullets : [] }));
  const all = title ? [{ heading: title, bullets: ['#ash Mesh · #ash AI Creative Studio'] }, ...list] : list;
  const deck = all.length ? all : [{ heading: title || 'Presentation', bullets: [] }];

  const entries = [
    {
      name: '[Content_Types].xml',
      data: contentTypes([
        { part: '/ppt/presentation.xml', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml' },
        { part: '/ppt/slideMasters/slideMaster1.xml', type: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml' },
        { part: '/ppt/slideLayouts/slideLayout1.xml', type: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml' },
        { part: '/ppt/theme/theme1.xml', type: 'application/vnd.openxmlformats-officedocument.theme+xml' },
        ...deck.map((_, index) => ({
          part: `/ppt/slides/slide${index + 1}.xml`,
          type: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
        })),
      ]),
    },
    { name: '_rels/.rels', data: rootRels('ppt/presentation.xml') },
    {
      name: 'ppt/presentation.xml',
      data: `${XML_HEAD}<p:presentation ${P_NS} saveSubsetFonts="1">` +
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
        '<p:sldIdLst>' +
        deck.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join('') +
        '</p:sldIdLst>' +
        `<p:sldSz cx="${SLIDE_CX}" cy="${SLIDE_CY}"/><p:notesSz cx="6858000" cy="9144000"/>` +
        '</p:presentation>',
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
        deck.map((_, index) => `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${deck.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>` +
        '</Relationships>',
    },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: SLIDE_MASTER },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: SLIDE_MASTER_RELS },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: SLIDE_LAYOUT },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: SLIDE_LAYOUT_RELS },
    { name: 'ppt/theme/theme1.xml', data: THEME },
  ];

  deck.forEach((slide, index) => {
    entries.push({ name: `ppt/slides/slide${index + 1}.xml`, data: slideXml(slide) });
    entries.push({ name: `ppt/slides/_rels/slide${index + 1}.xml.rels`, data: SLIDE_RELS });
  });

  return buildZip(entries);
}

/* -------------------------------- dispatcher ------------------------------ */

/**
 * Build an Office file in memory.
 * Returns { buffer, mime, ext } or throws a 400-status error for an unsupported format.
 */
export function buildOfficeFile({ format, title, content, rows, slides }) {
  const key = String(format || '').toLowerCase();
  const spec = OFFICE_FORMATS[key];
  if (!spec) {
    const err = new Error('Supported Office formats are DOCX, XLSX and PPTX.');
    err.status = 400;
    throw err;
  }
  if (key === 'docx') {
    if (!String(content ?? '').trim()) {
      const err = new Error('There is no content to write into the document.');
      err.status = 400;
      throw err;
    }
    return { buffer: buildDocx({ title, content }), mime: spec.mime, ext: spec.ext };
  }
  if (key === 'xlsx') {
    const clean = (Array.isArray(rows) ? rows : []).filter((row) => (Array.isArray(row) ? row.length : row != null && row !== ''));
    if (!clean.length) {
      const err = new Error('Provide rows to build the spreadsheet.');
      err.status = 400;
      throw err;
    }
    return { buffer: buildXlsx({ title, rows: clean }), mime: spec.mime, ext: spec.ext };
  }
  return { buffer: buildPptx({ title, slides }), mime: spec.mime, ext: spec.ext };
}
