import fc from "fast-check";
import type { HostDaemonRpcCommand } from "@bb/host-daemon-contract";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/errors.js";
import { containAbsolutePathWithinRoots } from "../../src/routes/host-path-containment.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  type QueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

/**
 * SP-2 (HI-2 / TG4): the thread raw-file endpoint must never read outside
 * the thread's registered roots (worktree + thread storage). Property: for
 * every requested absolute target, the server either rejects the request
 * without contacting the daemon, or the dispatched `host.read_file` carries
 * a registered root as `rootPath` with a target lexically inside it — a
 * root the daemon then enforces structurally via realpath on both sides.
 *
 * Written property-first per the TG3 discipline: against the pre-TG4 code
 * this fails immediately, because the endpoint forwarded any absolute path
 * to the daemon with no rootPath at all.
 */

const HTML = "<!doctype html><h1>ok</h1>";

type ReadFileCommand = Extract<
  HostDaemonRpcCommand,
  { type: "host.read_file" }
>;

const REJECTION_SETTLE_MS = 250;
const DISPATCH_WAIT_MS = 25_000;

interface RequestOutcome {
  status: number;
  bodyText: string;
  dispatched: ReadFileCommand | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestRawFile(
  harness: TestAppHarness,
  threadId: string,
  target: string,
): Promise<RequestOutcome> {
  // harness.app.request resolves to Response | Promise<Response>.
  const responsePromise: Promise<Response> = Promise.resolve(
    harness.app.request(
      `/api/v1/threads/${threadId}/files/raw?path=${encodeURIComponent(target)}`,
    ),
  );
  const settled = await Promise.race([
    responsePromise.then(() => true),
    sleep(REJECTION_SETTLE_MS).then(() => false),
  ]);

  let dispatched: ReadFileCommand | null = null;
  if (!settled) {
    // The request is still pending, so a daemon read was dispatched and is
    // awaiting an answer. COMMAND_TIMEOUT_MS is 30s, so the pending window
    // is far longer than this wait even under heavy load.
    let queued: QueuedCommand | null = null;
    try {
      queued = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "host.read_file",
        DISPATCH_WAIT_MS,
      );
    } catch {
      // No command materialized; fall through to the response classification.
    }
    if (queued) {
      dispatched = queued.command as ReadFileCommand;
      await reportQueuedCommandSuccess(harness, queued, {
        path: dispatched.path,
        content: HTML,
        contentEncoding: "utf8" as const,
        mimeType: "text/html",
        sizeBytes: Buffer.byteLength(HTML),
        sha256: "0".repeat(64),
      });
    }
  }

  const response = await responsePromise;
  const bodyText = await response.text();
  return { status: response.status, bodyText, dispatched };
}

function isLexicallyInside(root: string, target: string): boolean {
  if (!target.startsWith(`${root}/`)) {
    return false;
  }
  const segments = target.slice(root.length + 1).split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

const SEGMENT = /^[a-zA-Z0-9_-]{1,10}$/;

const posixRootArb = fc
  .tuple(fc.constant("/srv/roots"), fc.stringMatching(SEGMENT))
  .map(([base, name]) => `${base}/${name}`);

const win32RootArb = fc
  .tuple(fc.constantFrom("C:", "D:"), fc.stringMatching(SEGMENT))
  .map(([drive, name]) => `${drive}\\${name}`);

const posixRelativeArb = fc
  .array(fc.stringMatching(SEGMENT), { minLength: 1, maxLength: 3 })
  .map((segments) => segments.join("/"));

function isContained(rootPath: string, targetPath: string): boolean {
  const windows =
    path.win32.isAbsolute(rootPath) && !path.posix.isAbsolute(rootPath);
  const flavor = windows ? path.win32 : path.posix;
  const relative = flavor.relative(rootPath, targetPath);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${flavor.sep}`) &&
    !flavor.isAbsolute(relative)
  );
}

/**
 * The pure half of SP-2: containment is a total function over generated
 * roots and targets — for every input, either a rejection or a result that
 * is canonically inside exactly one of the registered roots, on the same
 * path flavor. numRuns is high because this is pure and fast.
 */
describe("SP-2 absolute-path containment (pure)", () => {
  it("contains every target inside a canonical registered root or rejects it", () => {
    const rootArb = fc.oneof(posixRootArb, win32RootArb);

    const targetArb = fc.oneof(
      // Inside a root, possibly with interior traversal that stays inside.
      fc
        .tuple(rootArb, posixRelativeArb)
        .map(([root, rel]) => `${root}/${rel}.html`),
      fc
        .tuple(win32RootArb, posixRelativeArb)
        .map(([root, rel]) => `${root}\\${rel.replaceAll("/", "\\")}.html`),
      fc
        .tuple(rootArb, fc.stringMatching(SEGMENT), posixRelativeArb)
        .map(([root, pivot, rel]) => `${root}/${pivot}/../${rel}/file.html`),
      // Traversal and sibling escapes.
      fc
        .tuple(rootArb, fc.stringMatching(SEGMENT))
        .map(([root, name]) => `${root}/../${name}.html`),
      fc
        .tuple(rootArb, posixRelativeArb)
        .map(([root, rel]) => `${root}/${rel}/../../../../../../escaped.html`),
      fc
        .tuple(rootArb, fc.stringMatching(SEGMENT))
        .map(([root, name]) => `${root}-sibling/${name}.html`),
      // Unrelated system locations.
      fc
        .tuple(fc.stringMatching(SEGMENT), fc.stringMatching(SEGMENT))
        .map(([dir, name]) => `/etc/${dir}/${name}.html`),
      // Foreign path flavors and exotic forms.
      fc
        .tuple(fc.constantFrom("C:", "D:"), fc.stringMatching(SEGMENT))
        .map(([drive, name]) => `${drive}\\${name}\\${name}.html`),
      fc
        .tuple(fc.stringMatching(SEGMENT), fc.stringMatching(SEGMENT))
        .map(([host, name]) => `\\\\${host}\\share\\${name}.html`),
      fc
        .tuple(fc.stringMatching(SEGMENT), fc.stringMatching(SEGMENT))
        .map(([host, name]) => `//${host}/share/${name}.html`),
      // Root itself, empty, and NUL injection.
      rootArb,
      fc.constant(""),
      fc
        .tuple(rootArb, fc.stringMatching(SEGMENT))
        .map(([root, name]) => `${root}/${name}\0.html`),
    );

    fc.assert(
      fc.property(
        fc.array(rootArb, { minLength: 1, maxLength: 3 }),
        targetArb,
        (roots, rawTarget) => {
          let admitted: { rootPath: string; path: string } | null = null;
          try {
            admitted = containAbsolutePathWithinRoots({
              rawPath: rawTarget,
              roots,
            });
          } catch (error) {
            expect(error).toBeInstanceOf(ApiError);
            expect((error as ApiError).status).toBe(400);
            expect((error as ApiError).body.code).toBe("invalid_path");
            if (rawTarget.length > 0) {
              expect((error as ApiError).body.message).not.toContain(rawTarget);
            }
          }
          if (admitted === null) {
            return;
          }
          const resolvedRoots = roots.map((root) =>
            path.win32.isAbsolute(root) && !path.posix.isAbsolute(root)
              ? path.win32.resolve(root)
              : path.posix.resolve(root),
          );
          expect(resolvedRoots).toContain(admitted.rootPath);
          const matchedFlavor =
            path.win32.isAbsolute(admitted.rootPath) &&
            !path.posix.isAbsolute(admitted.rootPath)
              ? path.win32
              : path.posix;
          expect(admitted.path).toBe(matchedFlavor.resolve(rawTarget));
          expect(admitted.path).not.toContain("\0");
          expect(isContained(admitted.rootPath, admitted.path)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("handles the audit's enumerated attack forms (4.5)", () => {
    const roots = ["/tmp/worktree", "/tmp/storage"];

    // Rejections: traversal, prefix traps, siblings, drive/UNC forms,
    // alternate separators, NUL, empty, and the roots themselves.
    for (const rejected of [
      "/tmp/worktree/../private.html",
      "/tmp/worktree/a/b/../../../../etc/passwd.html",
      "/tmp/worktree-prefix/file.html",
      "/tmp/worktree-sibling/file.html",
      "/etc/passwd.html",
      "C:\\Users\\someone\\report.html",
      "\\\\server\\share\\report.html",
      "//server/share/report.html",
      "/tmp/worktree/\0.html",
      "",
      "/tmp/worktree",
      "/tmp/storage",
      "relative/report.html",
      "C:relative.html",
    ]) {
      expect(
        () => containAbsolutePathWithinRoots({ rawPath: rejected, roots }),
        `expected rejection for ${JSON.stringify(rejected)}`,
      ).toThrow(ApiError);
    }

    // Admissions: canonicalization collapses to an in-root path; a
    // dot-prefixed sibling segment is admitted by this server half — but
    // the daemon's prefix check rejects names beginning with "..", so
    // end-to-end such reads fail closed (TG4 verdict Minor 1).
    expect(
      containAbsolutePathWithinRoots({
        rawPath: "/tmp/worktree/a/../b/report.html",
        roots,
      }),
    ).toEqual({
      rootPath: "/tmp/worktree",
      path: "/tmp/worktree/b/report.html",
    });
    expect(
      containAbsolutePathWithinRoots({
        rawPath: "/tmp/worktree//reports//report.html",
        roots,
      }),
    ).toEqual({
      rootPath: "/tmp/worktree",
      path: "/tmp/worktree/reports/report.html",
    });
    expect(
      containAbsolutePathWithinRoots({
        rawPath: "/tmp/worktree/..hidden/report.html",
        roots,
      }),
    ).toEqual({
      rootPath: "/tmp/worktree",
      path: "/tmp/worktree/..hidden/report.html",
    });

    // Windows roots admit case-variant and backslash targets (containment
    // comparison is case-insensitive; the target's own casing is preserved),
    // and reject traversal that leaves the drive path.
    const winRoots = ["C:\\workspaces\\ws"];
    expect(
      containAbsolutePathWithinRoots({
        rawPath: "c:\\workspaces\\ws\\sub\\report.html",
        roots: winRoots,
      }),
    ).toEqual({
      rootPath: "C:\\workspaces\\ws",
      path: "c:\\workspaces\\ws\\sub\\report.html",
    });
    expect(() =>
      containAbsolutePathWithinRoots({
        rawPath: "C:\\workspaces\\ws\\..\\other\\report.html",
        roots: winRoots,
      }),
    ).toThrow(ApiError);
  });
});

describe("SP-2 raw-file containment", () => {
  it(
    "rejects or root-bounds every /files/raw target against the thread's registered roots",
    { timeout: 120_000 },
    async () => {
      await withTestHarness(async (harness) => {
        const { host } = seedHostSession(harness.deps);
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/project-source",
        });
        const worktree = "/tmp/bb-worktrees/worktree-a";
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: worktree,
        });
        const thread = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
        });
        const storage = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}`;
        const roots = [worktree, storage];

        const target = fc.oneof(
          // Traversal straight out of a registered root.
          fc
            .constantFrom(worktree, storage)
            .map((root) => `${root}/../escaped.html`),
          fc
            .constantFrom(worktree, storage)
            .map((root) => `${root}/a/b/../../../../escaped.html`),
          // Siblings of a registered root and unrelated system locations.
          fc
            .constantFrom(worktree, storage)
            .map((root) => `${root}-sibling/report.html`),
          fc.constantFrom(
            "/etc/passwd.html",
            "/home/someone/private-report.html",
            "/tmp/elsewhere/report.html",
          ),
          // Windows drive and UNC forms under posix roots.
          fc.constantFrom(
            "C:\\Users\\someone\\report.html",
            "C:/Users/someone/report.html",
            "\\\\server\\share\\report.html",
            "//server/share/report.html",
          ),
          // In-root targets that traverse internally but stay inside.
          fc
            .constantFrom(worktree, storage)
            .map((root) => `${root}/reports/../reports/quarterly.html`),
          fc
            .constantFrom(worktree, storage)
            .map((root) => `${root}/reports/quarterly.html`),
        );

        await fc.assert(
          fc.asyncProperty(target, async (target) => {
            const outcome = await requestRawFile(harness, thread.id, target);
            if (outcome.dispatched !== null) {
              const { rootPath, path: dispatchedPath } = outcome.dispatched;
              if (rootPath === undefined) {
                expect.fail("dispatched host.read_file without a rootPath");
              }
              expect(roots).toContain(rootPath);
              expect(isLexicallyInside(rootPath, dispatchedPath)).toBe(true);
              expect(outcome.status).toBe(200);
            } else {
              expect(outcome.status).toBe(400);
              expect(outcome.bodyText).toContain("invalid_path");
              // Rejections must not leak filesystem structure (4.9).
              expect(outcome.bodyText).not.toContain(target);
            }
          }),
          { numRuns: 40 },
        );
      });
    },
  );
});
