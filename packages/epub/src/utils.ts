/** EPUB path-utility helpers. Resolves relative hrefs to ZIP-absolute paths. */

/** Resolve `href` against `baseDir` (a ZIP-internal directory). Returns the ZIP-absolute path, or `undefined` if `..` escapes the root (zip-slip protection). */
export function resolveHref(baseDir: string, href: string): string | undefined {
  const trimmedHref = href.trim();
  // ZIP resources are paths, never network or application URLs.
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmedHref) || trimmedHref.startsWith("//")) return undefined;
  const hashIndex = trimmedHref.indexOf("#");
  const withoutFragment = hashIndex === -1 ? trimmedHref : trimmedHref.slice(0, hashIndex);
  const queryIndex = withoutFragment.indexOf("?");
  const cleanHref = queryIndex === -1 ? withoutFragment : withoutFragment.slice(0, queryIndex);

  let decodedHref: string;
  try {
    decodedHref = decodeURIComponent(cleanHref);
  } catch {
    decodedHref = cleanHref;
  }
  decodedHref = decodedHref.replace(/\\/g, "/");

  const segments = decodedHref.startsWith("/") ? [] : baseDir ? baseDir.split("/").filter(Boolean) : [];
  for (const part of decodedHref.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return undefined; // escaped the root
      segments.pop();
      continue;
    }
    segments.push(part);
  }

  return segments.join("/");
}

/** Directory portion of a ZIP-absolute path (no trailing slash). */
export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}
