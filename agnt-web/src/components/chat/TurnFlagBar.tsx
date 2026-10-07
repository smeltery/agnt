// Inline picker for the per-turn flags the bridge accepts on `turn/start.params`:
// model, reasoningEffort, serviceTier, planMode, permissionMode. The flags persist in the
// threads-store across turns until the user changes them, matching iOS UX.

import { type PermissionMode, type ReasoningEffort, type ServiceTier, useThreadsStore } from "../../state/threads-store";

import { ActionPopover } from "../shared/ActionPopover";
import { ChevronDown } from "../shared/Icon";

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
    <ActionPopover label="Model and run settings" placement="top" className="agnt-run-settings"
      trigger={<><span>{selectedModel?.displayName ?? selectedModel?.name ?? flags.model ?? "Default model"}</span><ChevronDown size={13} /></>}>
      <div className="agnt-flagbar">
        <strong className="agnt-flagbar-title">Run settings</strong>
        <label className="agnt-flagbar-field">
          <span>Model</span>
          <select
            aria-label="Model"
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
            <option value="">Default model</option>
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
            aria-label="Reasoning"
            value={flags.reasoningEffort ?? ""}
            onChange={(event) =>
              patch({ reasoningEffort: (event.target.value || undefined) as ReasoningEffort | undefined })
            }
          >
            <option value="">Automatic</option>
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
            aria-label="Permission"
            value={flags.permissionMode ?? ""}
            onChange={(event) =>
              patch({ permissionMode: (event.target.value || undefined) as PermissionMode | undefined })
            }
          >
            <option value="">Default permissions</option>
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
    </ActionPopover>
  );
}
