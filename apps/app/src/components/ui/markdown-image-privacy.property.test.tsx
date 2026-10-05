// @vitest-environment jsdom


import { cleanup, render } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownPreview } from "./markdown-preview";

/**
 * SP-3 structural half (LO-2 / TG7.4): every http(s) image URL that
 * markdown rendering turns into an <img> must carry
 * `referrerPolicy="no-referrer"` — remote servers must not learn the
 * viewer's origin or browsing context from referrer headers, and unique
 * image URLs must not become tracking beacons beyond the fetch itself.
 * The property renders generated markdown and inspects the emitted DOM.
 */

afterEach(() => {
  cleanup();
});

const remoteImageUrlArb = fc
  .tuple(
    fc.constantFrom("https", "http"),
    fc.webSegment(),
    fc.stringMatching(/^[a-z0-9_-]{0,8}$/),
  )
  .map(([scheme, host, path]) => `${scheme}://${host}/${path}/track.png`);

function renderMarkdownImage(url: string): HTMLImageElement {
  const { container } = render(
    <MarkdownPreview content={`![generated](${url})`} />,
  );
  const image = container.querySelector("img[data-markdown-image]");
  if (!(image instanceof HTMLImageElement)) {
    throw new Error("Expected a rendered markdown image element");
  }
  return image;
}

describe("markdown image privacy (LO-2 / TG7.4)", () => {
  it("emits no-referrer on every rendered remote image", () => {
    fc.assert(
      fc.property(remoteImageUrlArb, (url) => {
        fc.pre(!url.includes("(") && !url.includes(")"));
        const image = renderMarkdownImage(url);
        expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
        expect(image.getAttribute("src")).toBe(url);
      }),
      { numRuns: 25 },
    );
  });
});
