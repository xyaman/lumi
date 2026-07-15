// Register happy-dom globals (document, Node, Range, Element, …) for tests that
// exercise DOM-walking code. The engine uses only native browser globals; this
// provides them under Node. Import for side effects at the top of a test.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof (globalThis as { document?: unknown }).document === "undefined") {
  GlobalRegistrator.register();
}
