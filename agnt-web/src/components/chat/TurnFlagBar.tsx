// Inline picker for the per-turn flags the bridge accepts on `turn/start.params`:
// model, reasoningEffort, serviceTier, planMode, permissionMode. The flags persist in the
// threads-store across turns until the user changes them, matching iOS UX.

import { type PermissionMode, type ReasoningEffort, type ServiceTier, useThreadsStore } from "../../state/threads-store";

const REASONING_OPTIONS: ReasoningEffort[] = ["low", "medium", "high"];
const PERMISSION_OPTIONS: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

export function TurnFlagBar() {
  const flags = useThreadsStore((state) => state.turnFlags);
  const models = useThreadsStore((state) => state.models);
  const patch = useThreadsStore((state) => state.patchTurnFlags);
  const selectedModel = flags.model
    ? models.find((model) => model.id === flags.model || model.model === flags.model)
    : models.find((model) => model.isDefault);
  const supportsFastMode = Boolean(selectedModel?.supportsFastMode);

  return (
    <div className="agnt-flagbar">
      <label className="agnt-flagbar-field">
        <span>Model</span>
        <select
          value={flags.model ?? ""}
          onChange={(event) => {
            const model = event.target.value || undefined;
            const nextModel = model
              ? models.find((entry) => entry.id === model || entry.model === model)
              : models.find((entry) => entry.isDefault);
            patch({
              model,
              serviceTier: nextModel?.supportsFastMode ? flags.serviceTier : undefined,
            });
          }}
        >
          <option value="">Bridge default</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.displayName ?? model.name ?? model.id}
            </option>
          ))}
        </select>
      </label>

      {supportsFastMode && (
        <label className="agnt-flagbar-toggle">
          <input
            type="checkbox"
            checked={flags.serviceTier === "fast"}
            onChange={(event) =>
              patch({ serviceTier: event.target.checked ? ("fast" as ServiceTier) : undefined })
            }
          />
          <span>Fast mode</span>
        </label>
      )}

      <label className="agnt-flagbar-field">
        <span>Reasoning</span>
        <select
          value={flags.reasoningEffort ?? ""}
          onChange={(event) =>
            patch({ reasoningEffort: (event.target.value || undefined) as ReasoningEffort | undefined })
          }
        >
          <option value="">default</option>
          {REASONING_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <label className="agnt-flagbar-field">
        <span>Permission</span>
        <select
          value={flags.permissionMode ?? ""}
          onChange={(event) =>
            patch({ permissionMode: (event.target.value || undefined) as PermissionMode | undefined })
          }
        >
          <option value="">bridge default</option>
          {PERMISSION_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <label className="agnt-flagbar-toggle">
        <input
          type="checkbox"
          checked={Boolean(flags.planMode)}
          onChange={(event) => patch({ planMode: event.target.checked })}
        />
        <span>Plan mode</span>
      </label>
    </div>
  );
}
