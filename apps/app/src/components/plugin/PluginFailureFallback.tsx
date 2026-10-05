import { appToast } from "@/components/ui/app-toast";

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
