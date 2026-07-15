import { type Book, buildBook, type Chapter, type Epub, parseEpub } from "@lumi/epub";

const drop = document.getElementById("drop") as HTMLLabelElement;
const input = document.getElementById("file") as HTMLInputElement;
const out = document.getElementById("out") as HTMLDivElement;

input.addEventListener("change", () => {
  const file = input.files?.[0];
  if (file) void load(file);
});

// Drag-and-drop onto the label.
for (const type of ["dragenter", "dragover"]) {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
}
for (const type of ["dragleave", "drop"]) {
  drop.addEventListener(type, () => drop.classList.remove("over"));
}
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = (e as DragEvent).dataTransfer?.files?.[0];
  if (file) void load(file);
});

async function load(file: File): Promise<void> {
  out.innerHTML = `<p class="muted">Parsing ${escapeHtml(file.name)}…</p>`;
  try {
    const t0 = performance.now();
    const epub = await parseEpub(file);
    const book = await buildBook(file.name, epub);
    const ms = Math.round(performance.now() - t0);
    render(epub, book, ms);
  } catch (err) {
    out.innerHTML = `<pre class="err">${escapeHtml(String(err))}</pre>`;
  }
}

function render(epub: Epub, book: Book, ms: number): void {
  out.innerHTML = "";
  out.append(
    metaBlock(epub, book, ms),
    warningsBlock(epub),
    tocBlock(book.chapters),
    sectionsBlock(book),
  );
}

function metaBlock(epub: Epub, book: Book, ms: number): HTMLElement {
  const m = epub.meta;
  const rows: [string, string][] = [
    ["title", m.title],
    ["creator", m.creator.join(", ") || "—"],
    ["language", m.language],
    ["direction", m.direction],
    ["layout", m.layout],
    ["spread", m.spread],
    ["epubVersion", m.epubVersion],
    ["spine items", String(epub.spine.length)],
    ["sections", String(book.sections.length)],
    ["total atoms", book.totalAtoms.toLocaleString()],
    ["parsed in", `${ms} ms`],
  ];
  const el = section("Metadata");
  const dl = document.createElement("dl");
  dl.className = "meta";
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  }
  el.append(dl);
  return el;
}

function warningsBlock(epub: Epub): HTMLElement {
  const el = section(`Warnings (${epub.warnings.length})`);
  if (epub.warnings.length === 0) {
    el.append(para("None.", "muted"));
    return el;
  }
  const ul = document.createElement("ul");
  for (const w of epub.warnings) {
    const li = document.createElement("li");
    li.className = "warn";
    li.textContent = `[${w.kind}] ${w.message}${w.path ? ` (${w.path})` : ""}`;
    ul.append(li);
  }
  el.append(ul);
  return el;
}

function tocBlock(chapters: Chapter[]): HTMLElement {
  const el = section(`Table of contents (${chapters.length} top-level)`);
  el.classList.add("toc");
  el.append(chapters.length ? chapterList(chapters) : para("No TOC.", "muted"));
  return el;
}

function chapterList(chapters: Chapter[]): HTMLElement {
  const ul = document.createElement("ul");
  for (const c of chapters) {
    const li = document.createElement("li");
    const target = c.target ? ` — spine ${c.target.spineIndex} @ atom ${c.target.offset}` : "";
    li.append(document.createTextNode(c.label || "(untitled)"));
    const span = document.createElement("span");
    span.className = "muted";
    span.textContent = target;
    li.append(span);
    if (c.children.length) li.append(chapterList(c.children));
    ul.append(li);
  }
  return ul;
}

function sectionsBlock(book: Book): HTMLElement {
  const el = section(`Sections (${book.sections.length})`);
  const table = document.createElement("table");
  table.innerHTML =
    "<thead><tr><th>#</th><th>spine</th><th>atoms</th><th>len</th><th>dir</th><th>image-only</th><th>href</th></tr></thead>";
  const tbody = document.createElement("tbody");
  book.sections.forEach((s, i) => {
    const tr = document.createElement("tr");
    const cells = [
      String(i),
      String(s.spineIndex),
      `${s.startAtom}–${s.endAtom}`,
      String(s.endAtom - s.startAtom),
      s.direction ?? "—",
      s.isImageOnly ? "yes" : "",
      s.href,
    ];
    cells.forEach((c, idx) => {
      const td = document.createElement("td");
      if (idx === cells.length - 1) td.className = "wrap";
      td.textContent = c;
      tr.append(td);
    });
    tbody.append(tr);
  });
  table.append(tbody);
  el.append(table);
  return el;
}

function section(title: string): HTMLElement {
  const el = document.createElement("section");
  const h = document.createElement("h2");
  h.style.fontSize = "15px";
  h.textContent = title;
  el.append(h);
  return el;
}

function para(text: string, className = ""): HTMLElement {
  const p = document.createElement("p");
  if (className) p.className = className;
  p.textContent = text;
  return p;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}
