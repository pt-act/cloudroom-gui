// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PluginFailureFallback } from "./PluginFailureFallback";

afterEach(cleanup);

describe("PluginFailureFallback (ME-8, TG11.2)", () => {
  it("announces the failure and identifies the plugin and slot", () => {
    render(
      <PluginFailureFallback pluginId="linear" slotLabel="appOverlay/42" />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Plugin linear failed to render");
    expect(alert.textContent).toContain("appOverlay/42");
  });

  it("offers reload and settings actions (9.14: no credentials in the surface)", () => {
    render(
      <PluginFailureFallback pluginId="linear" slotLabel="appOverlay/42" />,
    );
    expect(screen.getByRole("button", { name: "Reload page" })).toBeTruthy();
    const settings = screen.getByRole("link", {
      name: "Open plugin settings",
    });
    expect(settings.getAttribute("href")).toBe("/settings/plugins/linear");
  });
});
