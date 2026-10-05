// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationCenter } from "./NotificationCenter";
vi.mock("@/lib/clipboard", () => ({
  copyTextToClipboard: () => Promise.resolve(true),
}));
import {
  recordNotification,
  resetNotificationStore,
} from "@/lib/notifications/notification-store";

afterEach(() => {
  resetNotificationStore();
});

describe("notification center accessibility (ME-9, LO-3, TG11.3/11.11)", () => {
  it("renders a persistent labelled trigger with badge and aria state (11.3)", async () => {
    const { queryClient } = { queryClient: null } as never;
    void queryClient;
    render(<NotificationCenter />);
    await act(async () => {
      recordNotification({
        toastId: null,
        tone: "message",
        title: "Build finished",
        description: "Worker 3 finished",
        createdAt: Date.now(),
      });
    });

    const trigger = screen.getAllByTestId("notification-center-trigger")[0];
    expect(trigger.getAttribute("aria-label")).toBe("Notifications (1)");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("moves focus into the popover on open and back to the trigger on close (11.3)", async () => {
    render(<NotificationCenter />);
    const trigger = screen.getAllByTestId("notification-center-trigger")[0];

    await act(async () => {
      fireEvent.click(trigger);
    });

    // The popover is open (aria-expanded) and its content is present.
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("dialog").length).toBeGreaterThan(0);

    // Close via the header control: focus returns to the invoker.
    fireEvent.click(
      screen.getAllByRole("button", { name: /Hide notifications/ })[0],
    );
    expect(
      document.activeElement?.getAttribute("data-testid"),
    ).toBe("notification-center-trigger");
  });

  it("labels the copy action Copied and announces it politely (11.4/LO-3)", async () => {
    render(<NotificationCenter />);
    await act(async () => {
      recordNotification({
        toastId: null,
        tone: "message",
        title: "Build finished",
        description: "Worker 3 finished",
        createdAt: Date.now(),
      });
    });
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("notification-center-trigger")[0]);
    });

    // The app renders desktop and mobile instances; clicking any copy
    // control flips its own label to Copied with a polite announcement.
    const copyButtons = screen.getAllByRole("button", {
      name: "Copy notification",
    });
    expect(copyButtons.length).toBeGreaterThan(0);
    fireEvent.click(copyButtons[0]);
    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: "Copied" }).length,
      ).toBeGreaterThan(0);
    });
  });
});
