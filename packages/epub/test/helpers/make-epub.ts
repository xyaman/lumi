// テスト用に最小構成のEPUBをメモリ上に組み立てる。
// エントリはすべて無圧縮(method 0)で書き出す。zip.tsはこれを読める。

const encoder = new TextEncoder();

type Entry = { name: string; data: Uint8Array };

export type ManifestEntry = {
  id: string;
  href: string; // OPFからの相対パス
  mediaType: string;
  properties?: string;
  fallback?: string;
};

export type SpineEntry = {
  idref: string;
  linear?: boolean;
  properties?: string;
};

export type EpubSpec = {
  files?: Record<string, string>; // OPFからの相対パス → 中身
  manifest?: ManifestEntry[];
  spine?: SpineEntry[];
  nav?: string; // nav.xhtml の <body> 内側
  ncx?: string; // 指定時はNCXを追加しEPUB2として扱う
  direction?: "ltr" | "rtl";
  version?: string;
  title?: string;
  layout?: string; // rendition:layout の <meta> を metadata に追加
  spread?: string; // rendition:spread の <meta> を metadata に追加
};

// ローカルファイルヘッダ + データ
function localHeader(e: Entry, offset: number): { bytes: Uint8Array; offset: number } {
  const name = encoder.encode(e.name);
  const buf = new Uint8Array(30 + name.length + e.data.length);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true); // version needed
  view.setUint16(8, 0, true); // method: stored
  view.setUint32(14, 0, true); // crc32 — reader does not verify
  view.setUint32(18, e.data.length, true);
  view.setUint32(22, e.data.length, true);
  view.setUint16(26, name.length, true);
  buf.set(name, 30);
  buf.set(e.data, 30 + name.length);
  return { bytes: buf, offset };
}

// 中央ディレクトリの1エントリ
function centralEntry(e: Entry, localOffset: number): Uint8Array {
  const name = encoder.encode(e.name);
  const buf = new Uint8Array(46 + name.length);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(10, 0, true); // method: stored
  view.setUint32(16, 0, true); // crc32
  view.setUint32(20, e.data.length, true);
  view.setUint32(24, e.data.length, true);
  view.setUint16(28, name.length, true);
  view.setUint32(42, localOffset, true);
  buf.set(name, 46);
  return buf;
}

// エントリ列から有効なZIPアーカイブを作る。
export function buildZip(entries: Entry[]): Blob {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const { bytes } = localHeader(e, offset);
    locals.push(bytes);
    centrals.push(centralEntry(e, offset));
    offset += bytes.length;
  }

  const cdOffset = offset;
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);

  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entries.length, true);
  view.setUint16(10, entries.length, true);
  view.setUint32(12, cdSize, true);
  view.setUint32(16, cdOffset, true);

  return new Blob([...locals, ...centrals, eocd] as BlobPart[]);
}

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

// XHTMLドキュメントを1つ組み立てる（bodyのクラス・ID・head追加内容を指定可能）。
export function xhtml(
  body: string,
  opts: { bodyClass?: string; bodyId?: string; htmlClass?: string; head?: string } = {},
): string {
  const htmlClass = opts.htmlClass ? ` class="${opts.htmlClass}"` : "";
  const bodyClass = opts.bodyClass ? ` class="${opts.bodyClass}"` : "";
  const bodyId = opts.bodyId ? ` id="${opts.bodyId}"` : "";
  const head = opts.head ?? "";
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"${htmlClass}>
<head><title>t</title>${head}</head>
<body${bodyClass}${bodyId}>${body}</body>
</html>`;
}

// EPUB仕様からBlobを生成する。parseEpub()にそのまま渡せる。
export function makeEpub(spec: EpubSpec = {}): Blob {
  const version = spec.version ?? "3.0";
  const manifest = [...(spec.manifest ?? [])];
  const spine = spec.spine ?? [];
  const files = { ...(spec.files ?? {}) };

  if (spec.nav !== undefined) {
    files["nav.xhtml"] = xhtml(`<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc">${spec.nav}</nav>`);
    manifest.push({ id: "nav", href: "nav.xhtml", mediaType: "application/xhtml+xml", properties: "nav" });
  }
  if (spec.ncx !== undefined) {
    files["toc.ncx"] = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head/><docTitle><text>t</text></docTitle>
  <navMap>${spec.ncx}</navMap>
</ncx>`;
    manifest.push({ id: "ncx", href: "toc.ncx", mediaType: "application/x-dtbncx+xml" });
  }

  const manifestXml = manifest
    .map(
      (m) =>
        `<item id="${m.id}" href="${m.href}" media-type="${m.mediaType}"` +
        (m.properties ? ` properties="${m.properties}"` : "") +
        (m.fallback ? ` fallback="${m.fallback}"` : "") +
        `/>`,
    )
    .join("\n    ");

  const spineXml = spine
    .map(
      (s) =>
        `<itemref idref="${s.idref}"` +
        (s.linear === false ? ` linear="no"` : "") +
        (s.properties ? ` properties="${s.properties}"` : "") +
        `/>`,
    )
    .join("\n    ");

  const renditionMeta =
    (spec.layout !== undefined ? `\n    <meta property="rendition:layout">${spec.layout}</meta>` : "") +
    (spec.spread !== undefined ? `\n    <meta property="rendition:spread">${spec.spread}</meta>` : "");

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${version}" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${spec.title ?? "テスト"}</dc:title>
    <dc:language>ja</dc:language>
    <dc:identifier id="bookid">urn:uuid:test</dc:identifier>${renditionMeta}
  </metadata>
  <manifest>
    ${manifestXml}
  </manifest>
  <spine${spec.ncx !== undefined ? ' toc="ncx"' : ""} page-progression-direction="${spec.direction ?? "rtl"}">
    ${spineXml}
  </spine>
</package>`;

  // mimetypeは最初のエントリでなければならない。
  const entries: Entry[] = [
    { name: "mimetype", data: encoder.encode("application/epub+zip") },
    { name: "META-INF/container.xml", data: encoder.encode(CONTAINER) },
    { name: "OEBPS/content.opf", data: encoder.encode(opf) },
  ];
  for (const [href, content] of Object.entries(files)) {
    entries.push({ name: `OEBPS/${href}`, data: encoder.encode(content) });
  }

  return buildZip(entries);
}
