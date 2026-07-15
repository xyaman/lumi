/** EPUB path-utility helpers. Resolves relative hrefs to ZIP-absolute paths. */

/** Resolve `href` against `baseDir` (a ZIP-internal directory). Returns the ZIP-absolute path, or `undefined` if `..` escapes the root (zip-slip protection). */
export function resolveHref(baseDir: string, href: string): string | undefined {
  const trimmedHref = href.trim();
  const hashIndex = trimmedHref.indexOf("#");
  const cleanHref = hashIndex === -1 ? trimmedHref : trimmedHref.slice(0, hashIndex);

  const segments = baseDir ? baseDir.split("/").filter(Boolean) : [];
  for (const part of cleanHref.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return undefined; // escaped the root
      segments.pop();
      continue;
    }
    segments.push(part);
  }

  let resolved: string;
  try {
    resolved = segments.map(decodeURIComponent).join("/");
  } catch {
    // Bad percent-encoding — fall back to literal segments joined.
    resolved = segments.join("/");
  }
  return resolved;
}

/** Directory portion of a ZIP-absolute path (no trailing slash). */
export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}
