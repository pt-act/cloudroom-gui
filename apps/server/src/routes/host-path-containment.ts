import path from "node:path";
import { ApiError } from "../errors.js";

export interface ContainedAbsolutePath {
  rootPath: string;
  path: string;
}

function createInvalidRawFilePathError(): ApiError {
  return new ApiError(400, "invalid_path", "Invalid file path", false);
}

function prefersWindowsSemantics(value: string): boolean {
  return path.win32.isAbsolute(value) && !path.posix.isAbsolute(value);
}

/**
 * Lexical containment for absolute host paths. This is the server-side half
 * of the HI-2 boundary (SP-2); the daemon supplies the structural half by
 * realpathing both the root and the target before reading. A target is
 * admitted only when some registered root — canonicalized on the same path
 * flavor as the target — strictly contains it after normalization.
 * Traversal that escapes, foreign path flavors, and the roots themselves are
 * rejected, and the error never echoes the requested path.
 */
export function containAbsolutePathWithinRoots(args: {
  rawPath: string;
  roots: readonly string[];
}): ContainedAbsolutePath {
  if (
    args.rawPath.length === 0 ||
    args.rawPath.includes("\0") ||
    (!path.posix.isAbsolute(args.rawPath) &&
      !path.win32.isAbsolute(args.rawPath))
  ) {
    throw createInvalidRawFilePathError();
  }
  for (const rootPath of args.roots) {
    const windows = prefersWindowsSemantics(rootPath);
    if (windows !== prefersWindowsSemantics(args.rawPath)) {
      continue;
    }
    const flavor = windows ? path.win32 : path.posix;
    const canonicalRoot = flavor.resolve(rootPath);
    const canonicalTarget = flavor.resolve(args.rawPath);
    const relative = flavor.relative(canonicalRoot, canonicalTarget);
    // Deliberate half-boundary (TG4 verdict Minor 1): this check admits an
    // in-root name that merely begins with dots (e.g. ..foo), while the
    // daemon's isPathWithinDirectory uses a startsWith("..") prefix test and
    // rejects it. End-to-end the request fails closed — no escape, no
    // disclosure. Do not align either half toward the other without
    // verifying both: "fixing" the daemon would widen it, "fixing" this
    // side would only mirror behavior nobody observed end-to-end.
    const escaped =
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${flavor.sep}`) ||
      flavor.isAbsolute(relative);
    if (!escaped) {
      return { rootPath: canonicalRoot, path: canonicalTarget };
    }
  }
  throw createInvalidRawFilePathError();
}
