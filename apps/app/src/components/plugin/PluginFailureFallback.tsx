import { appToast } from "@/components/ui/app-toast";

/**
 * Shared compact plugin failure state (ME-8, TG11.2): rendered by plugin
 * slots whose component crashed, so a plugin failure is announced
 * (role="alert"), identified by plugin name and slot, and offers a reload
 * plus a settings path instead of silently removing the UI.
 *
 * The diagnostics reference is the slot instance key — the same key the
 * client logs use (`[plugin:<id>] slot "<key>" crashed ...`), so a
 * reported failure can be matched to its log line without exposing
 * credentials or tokens.
 */
export function PluginFailureFallback({
  pluginId,
  slotLabel,
}: {
  pluginId: string;
  slotLabel: string;
}) {
  return (
    <div
      role="alert"
      data-testid={`plugin-failure-${pluginId}`}
      className="my-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground"
    >
      <div className="font-medium text-foreground">
        Plugin {pluginId} failed to render
      </div>
      <div className="mt-0.5">
        Diagnostics reference: <code className="font-mono">{slotLabel}</code>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <button
          type="button"
          className="rounded-sm border border-border px-2 py-0.5 hover:bg-accent"
          onClick={() => {
            appToast.warning(
              `Reloading the page to recover plugin ${pluginId}`,
            );
            window.location.reload();
          }}
        >
          Reload page
        </button>
        <a
          href={`/settings/plugins/${pluginId}`}
          className="rounded-sm border border-border px-2 py-0.5 hover:bg-accent"
        >
          Open plugin settings
        </a>
      </div>
    </div>
  );
}
