// @vitest-environment node

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MINI_APP_SCENES } from "./MiniAppScenes";

/**
 * IN-1 (TG11.8): MiniAppScenes demo labels must resolve their text colors
 * through the semantic `--ink`/`--canvas` tokens (via the showcase token
 * helpers) rather than hard-coded hex/rgb values, and the ink-on-canvas
 * pair must meet WCAG AA contrast (4.5:1) for normal-size text in both
 * themes.
 */

const THEME_CSS = readFileSync(
  join(__dirname, "../../../components/ui/theme.css"),
  "utf8",
);

const SCENES_SOURCE = readFileSync(
  join(__dirname, "./MiniAppScenes.tsx"),
  "utf8",
);

/** Achromatic oklch L -> relative luminance (Y = L^3 for L=0 chroma). */
function oklchAchromaticLuminance(lightness: number): number {
  return lightness ** 3;
}

function wcagContrast(yA: number, yB: number): number {
  const lighter = Math.max(yA, yB);
  const darker = Math.min(yA, yB);
  return (lighter + 0.05) / (darker + 0.05);
}

function themeInkLightness(themeBlock: string): number {
  const match = /--ink:\s*oklch\(([\d.]+)\s+0\s+0\)/.exec(themeBlock);
  if (!match) {
    throw new Error("Expected an achromatic --ink token");
  }
  return Number(match[1]);
}

function themeCanvasLightness(themeBlock: string): number {
  const match = /--canvas:\s*oklch\(([\d.]+)\s+0\s+0\)/.exec(themeBlock);
  if (!match) {
    throw new Error("Expected an achromatic --canvas token");
  }
  return Number(match[1]);
}

function themeBlock(selector: string): string {
  const marker = `${selector} {\n  color-scheme:`;
  const index = THEME_CSS.indexOf(marker);
  if (index < 0) {
    throw new Error(`Theme block ${selector} not found`);
  }
  const next = THEME_CSS.indexOf("\n}", index + marker.length);
  return THEME_CSS.slice(index, next < 0 ? undefined : next);
}

describe("MiniAppScenes token usage (IN-1, TG11.8)", () => {
  it("contains no hard-coded hex or rgb colors", () => {
    expect(SCENES_SOURCE).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(SCENES_SOURCE).not.toMatch(/rgb\(|rgba\(/);
  });

  it("pulls its text colors from the showcase token helpers", () => {
    expect(SCENES_SOURCE).toContain("neutral(");
    expect(SCENES_SOURCE).toContain("accentTint(");
    expect(SCENES_SOURCE).toContain("accentInk(");
  });

  it("defines MINI_APP_SCENES", () => {
    expect(Object.keys(MINI_APP_SCENES).length).toBeGreaterThan(0);
  });

  it("keeps ink-on-canvas text at AA contrast in both themes", () => {
    for (const selector of [".light", ".dark"]) {
      const block = themeBlock(selector);
      const ink = themeInkLightness(block);
      const canvas = themeCanvasLightness(block);
      const contrast = wcagContrast(
        oklchAchromaticLuminance(ink),
        oklchAchromaticLuminance(canvas),
      );
      // The token pair itself must clear AA (4.5:1) comfortably for the
      // mixed normal-size labels to stay readable.
      expect(
        contrast,
        `${selector} ink/canvas contrast`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
