import type { EpubWarning, ErrorKind, WarningKind } from "./types";

/** Inputs for constructing an `EpubParseError`. */
type ParseErrorOptions = {
  kind: ErrorKind;
  /** User-facing message. */
  message: string;
  path?: string; // ZIP-absolute file path, when applicable
  cause?: unknown;
};

/** `fail()` extras beyond `kind` and `message`. */
type FailOptions = Pick<ParseErrorOptions, "path" | "cause">;

/** Fatal parse error. `message` is user-facing. */
export class EpubParseError extends Error {
  readonly kind: ErrorKind;
  readonly path?: string;
  readonly cause?: unknown;

  constructor(opts: ParseErrorOptions) {
    super(opts.message);
    this.name = "EpubParseError";
    this.kind = opts.kind;
    this.path = opts.path;
    this.cause = opts.cause;
  }
}

/** Throw an `EpubParseError`. */
export function fail(kind: ErrorKind, message: string, opts: FailOptions = {}): never {
  throw new EpubParseError({ kind, message, ...opts });
}

/** Collects non-fatal warnings during parsing. */
export class WarningCollector {
  readonly list: EpubWarning[] = [];

  add(kind: WarningKind, message: string, path?: string): void {
    this.list.push({ kind, message, path });
  }
}
