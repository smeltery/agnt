#[derive(serde::Serialize, Clone, Debug)]
pub struct DiagnosticAction {
    pub kind: String,
    pub label: String,
    pub value: Option<String>,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct DiagnosticCheck {
    pub id: String,
    pub title: String,
    pub status: String,
    pub detail: String,
    pub action: Option<DiagnosticAction>,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct SetupPreset {
    pub id: String,
    pub title: String,
    pub detail: String,
    pub status: String,
    pub action: Option<DiagnosticAction>,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct DiagnosticsSnapshot {
    pub generated_at: String,
    pub summary: String,
    pub checks: Vec<DiagnosticCheck>,
    pub presets: Vec<SetupPreset>,
    pub recommended_actions: Vec<DiagnosticAction>,
    pub runtime: crate::runtime_bundle::RuntimeBundleStatus,
    pub debug: crate::app_types::DebugInfo,
}

pub(crate) fn diagnostic_action(
    kind: &str,
    label: &str,
    value: Option<String>,
) -> DiagnosticAction {
    DiagnosticAction {
        kind: kind.to_string(),
        label: label.to_string(),
        value,
    }
}

pub(crate) fn diagnostic_check(
    id: &str,
    title: &str,
    status: &str,
    detail: String,
    action: Option<DiagnosticAction>,
) -> DiagnosticCheck {
    DiagnosticCheck {
        id: id.to_string(),
        title: title.to_string(),
        status: status.to_string(),
        detail,
        action,
    }
}
