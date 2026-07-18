import { fail, WarningCollector } from "./errors";
import { parseNav, parseNcx, type NavResult } from "./nav";
import { parseOpf } from "./opf";
import type { Epub, ManifestItem, NavPoint, Resource } from "./types";
import { findElement, NS, parseXml } from "./xml";
import { openZip, type ZipReader } from "./zip";

const CONTAINER_PATH = "META-INF/container.xml";

/** Parse a ZIP blob into a fully populated `Epub`. */
export async function parseEpub(file: Blob): Promise<Epub> {
  const warn = new WarningCollector();
  const zip = await openZip(file);

  const opfPath = await findOpfPath(zip);
  const opfText = await zip.readText(opfPath);
  if (opfText === undefined) {
    fail("missing-opf", `The package document \`${opfPath}\` declared in container.xml was not found in the ZIP.`, {
      path: opfPath,
    });
  }
  const { meta, manifest, spine, rootDir, navId, ncxId } = parseOpf(opfText, opfPath, warn);

  // Prefer the EPUB 3 nav document, then fall back to the EPUB 2 NCX.
  const { toc, landmarks } = await readNav({ zip, manifest, navId, ncxId, warn });

  // Resources are lazy: bytes are fetched only when `load()` is called.
  const resources = new Map<string, Resource>();
  for (const item of manifest.values()) {
    const entry = zip.entries.get(item.href);
    if (!entry) continue; // missing entries surface as reference errors at render time
    let loaded: Promise<Uint8Array> | null = null;
    resources.set(item.href, {
      href: item.href,
      mediaType: item.mediaType,
      size: entry.uncompressedSize,
      load: () => {
        loaded ??= (async () => {
          const bytes = await zip.read(item.href);
          if (!bytes) throw new Error(`Resource missing from archive: ${item.href}`);
          return bytes;
        })();
        return loaded;
      },
    });
  }

  return { meta, manifest, spine, nav: toc, landmarks, resources, rootDir, warnings: warn.list };
}

async function findOpfPath(zip: ZipReader): Promise<string> {
  const text = await zip.readText(CONTAINER_PATH);
  if (!text) {
    fail("missing-container", `The EPUB is missing the required \`${CONTAINER_PATH}\` file.`, { path: CONTAINER_PATH });
  }

  const doc = parseXml(text, "invalid-container-xml", CONTAINER_PATH);
  // EPUB 3 allows multiple <rootfile> entries; the first wins in practice.
  const rootfiles = findElement(doc, NS.ocf, "rootfiles");
  const rootfile = rootfiles && findElement(rootfiles, NS.ocf, "rootfile");
  const fullPath = rootfile?.getAttribute("full-path");

  if (!fullPath) {
    fail(
      "missing-rootfile",
      `\`${CONTAINER_PATH}\` does not declare a rootfile. The package document location is unknown.`,
      { path: CONTAINER_PATH },
    );
  }

  return fullPath;
}

type ReadNavArgs = {
  zip: ZipReader;
  manifest: Map<string, ManifestItem>;
  navId?: string;
  ncxId?: string;
  warn: WarningCollector;
};

async function readNav(args: ReadNavArgs): Promise<NavResult> {
  const { zip, manifest, navId, ncxId, warn } = args;
  let navLandmarks: NavResult["landmarks"] = [];

  if (navId) {
    const item = manifest.get(navId);
    const text = item && (await zip.readText(item.href));
    if (item && text) {
      const { toc, landmarks } = parseNav(text, item.href, warn);
      navLandmarks = landmarks;
      if (isUsableToc(toc, manifest)) return { toc, landmarks };
      warn.add(
        "unusable-nav-hrefs",
        `The TOC in \`${item.href}\` is empty or most of its hrefs do not resolve to manifest items. Falling back to NCX if available.`,
        item.href,
      );
    }
  } else {
    warn.add("missing-nav-document", "No EPUB 3 navigation document was declared. Falling back to NCX if available.");
  }

  let ncxItem = ncxId ? manifest.get(ncxId) : undefined;
  if (ncxId && !ncxItem) {
    warn.add("missing-ncx", `Spine references toc="${ncxId}" but no such manifest item exists.`);
  }
  ncxItem ??= findNcxItem(manifest);
  if (ncxItem) {
    const text = await zip.readText(ncxItem.href);
    if (text) return { toc: parseNcx(text, ncxItem.href, warn), landmarks: navLandmarks };
  }

  return { toc: [], landmarks: navLandmarks };
}

/** True when enough TOC hrefs resolve to a manifest item to be navigable. */
function isUsableToc(toc: NavPoint[], manifest: Map<string, ManifestItem>): boolean {
  // Nav hrefs pointing outside the OPF root can't be matched to reader resources, so we treat that as unusable.
  const hrefs = new Set([...manifest.values()].map((item) => item.href));
  let total = 0;
  let matched = 0;

  const walk = (points: NavPoint[]): void => {
    for (const point of points) {
      if (point.href) {
        total++;
        const hashAt = point.href.indexOf("#");
        const path = hashAt === -1 ? point.href : point.href.slice(0, hashAt);
        if (hrefs.has(path)) matched++;
      }
      walk(point.children);
    }
  };

  walk(toc);
  return total > 0 && matched / total >= 0.5;
}

/** Locate the EPUB 2 NCX item in the manifest. Fallback path when no nav document is declared. */
function findNcxItem(manifest: Map<string, ManifestItem>): ManifestItem | undefined {
  return [...manifest.values()].find((item) => item.mediaType === "application/x-dtbncx+xml");
}
