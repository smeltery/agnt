use std::fs;
use std::path::{Path, PathBuf};

pub(crate) const BUNDLE_MANIFEST: &str = "agnt-bundle.json";

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct BundlePackageMetadata {
    pub name: Option<String>,
    pub version: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct BundleComponentManifest {
    pub package: Option<BundlePackageMetadata>,
    pub hash: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct BundleManifest {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
    pub relay: BundleComponentManifest,
    pub bridge: BundleComponentManifest,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct RuntimeBundleStatus {
    pub bundled_manifest: Option<BundleManifest>,
    pub runtime_manifest: Option<BundleManifest>,
    pub runtime_current: bool,
    pub refresh_available: bool,
    pub refresh_deferred: bool,
    pub bundled_path: String,
    pub runtime_path: String,
    pub message: String,
}

pub(crate) fn runtime_root() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("agnt-host")
        .join("runtime")
}

pub(crate) fn bundled_root_from_exe() -> Option<PathBuf> {
    let exe_path = std::env::current_exe().ok()?;
    let exe_dir = exe_path.parent()?;
    let bundled_root = exe_dir.join("bundled");
    let bundled_relay = bundled_root.join("relay").join("server.js");
    let bundled_bridge = bundled_root.join("agnt-bridge").join("bin").join("agnt.js");
    if bundled_relay.exists() && bundled_bridge.exists() {
        Some(bundled_root)
    } else {
        None
    }
}

pub(crate) fn read_bundle_manifest(path: &Path) -> Option<BundleManifest> {
    let raw = fs::read_to_string(path.join(BUNDLE_MANIFEST)).ok()?;
    serde_json::from_str::<BundleManifest>(&raw).ok()
}

pub(crate) fn bundle_manifests_match(bundled: &BundleManifest, runtime: &BundleManifest) -> bool {
    bundled.schema_version == runtime.schema_version
        && bundled.relay.hash == runtime.relay.hash
        && bundled.bridge.hash == runtime.bridge.hash
        && bundled.relay.package == runtime.relay.package
        && bundled.bridge.package == runtime.bridge.package
}

pub(crate) fn runtime_bundle_status(processes_running: bool) -> RuntimeBundleStatus {
    let bundled_root = bundled_root_from_exe();
    let runtime = runtime_root();
    let bundled_manifest = bundled_root.as_ref().and_then(|p| read_bundle_manifest(p));
    let runtime_manifest = read_bundle_manifest(&runtime);
    let runtime_current = match (&bundled_manifest, &runtime_manifest) {
        (Some(bundled), Some(runtime)) => bundle_manifests_match(bundled, runtime),
        _ => false,
    };
    let refresh_available = bundled_manifest.is_some() && !runtime_current;
    let refresh_deferred = refresh_available && processes_running;
    let message = if bundled_manifest.is_none() {
        "No packaged bundle manifest was found. This is expected in development mode.".to_string()
    } else if runtime_current {
        "Runtime bridge and relay match the packaged bundle.".to_string()
    } else if refresh_deferred {
        "Restart Host to apply the packaged bridge and relay update.".to_string()
    } else {
        "Runtime bridge and relay can be refreshed from the packaged bundle.".to_string()
    };

    RuntimeBundleStatus {
        bundled_manifest,
        runtime_manifest,
        runtime_current,
        refresh_available,
        refresh_deferred,
        bundled_path: bundled_root
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "(development mode)".to_string()),
        runtime_path: runtime.display().to_string(),
        message,
    }
}

fn copy_file_if_exists(src: &Path, dest: &Path) -> std::io::Result<()> {
    if src.exists() {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dest)?;
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    if !src.exists() {
        return Ok(());
    }
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dest_path = dest.join(entry.file_name());
        if file_type.is_dir() {
            if entry.file_name() != "node_modules" && entry.file_name() != ".git" {
                copy_dir_recursive(&entry.path(), &dest_path)?;
            }
        } else {
            let _ = fs::copy(entry.path(), dest_path);
        }
    }
    Ok(())
}

fn validate_runtime_tree(root: &Path) -> Result<(), String> {
    let relay_server = root.join("relay").join("server.js");
    let bridge_bin = root.join("agnt-bridge").join("bin").join("agnt.js");
    if !relay_server.exists() {
        return Err(format!("missing {}", relay_server.display()));
    }
    if !bridge_bin.exists() {
        return Err(format!("missing {}", bridge_bin.display()));
    }
    if !root.join(BUNDLE_MANIFEST).exists() {
        return Err(format!("missing {}", root.join(BUNDLE_MANIFEST).display()));
    }
    Ok(())
}

pub(crate) fn seed_runtime_from_bundle(bundled_root: &Path, runtime: &Path) {
    let relay_dest = runtime.join("relay");
    if !relay_dest.join("server.js").exists() {
        let relay_src = bundled_root.join("relay");
        if let Err(e) = copy_dir_recursive(&relay_src, &relay_dest) {
            log::warn!("Failed to copy relay to runtime dir: {e}");
        }
    }

    let bridge_dest = runtime.join("agnt-bridge");
    if !bridge_dest.join("bin").join("agnt.js").exists() {
        let bridge_src = bundled_root.join("agnt-bridge");
        if let Err(e) = copy_dir_recursive(&bridge_src, &bridge_dest) {
            log::warn!("Failed to copy bridge to runtime dir: {e}");
        }
    }

    let _ = copy_file_if_exists(
        &bundled_root.join(BUNDLE_MANIFEST),
        &runtime.join(BUNDLE_MANIFEST),
    );
}

pub(crate) fn refresh_runtime_from_bundle(
    processes_running: bool,
) -> Result<RuntimeBundleStatus, String> {
    let bundled_root = match bundled_root_from_exe() {
        Some(path) => path,
        None => return Ok(runtime_bundle_status(processes_running)),
    };
    let status = runtime_bundle_status(processes_running);
    if !status.refresh_available || status.runtime_current {
        return Ok(status);
    }
    if processes_running {
        return Ok(status);
    }

    let runtime = runtime_root();
    copy_runtime_from_bundle(&bundled_root, &runtime)?;
    Ok(runtime_bundle_status(false))
}

fn copy_runtime_from_bundle(bundled_root: &Path, runtime: &Path) -> Result<(), String> {
    let parent = runtime
        .parent()
        .ok_or_else(|| "Runtime directory has no parent".to_string())?
        .to_path_buf();
    fs::create_dir_all(&parent).map_err(|e| format!("runtime parent create failed: {e}"))?;

    let tmp = parent.join("runtime-refresh-tmp");
    let backup = parent.join("runtime-refresh-backup");
    let _ = fs::remove_dir_all(&tmp);
    let _ = fs::remove_dir_all(&backup);
    fs::create_dir_all(&tmp).map_err(|e| format!("runtime temp create failed: {e}"))?;

    copy_dir_recursive(&bundled_root.join("relay"), &tmp.join("relay"))
        .map_err(|e| format!("relay copy failed: {e}"))?;
    copy_dir_recursive(&bundled_root.join("agnt-bridge"), &tmp.join("agnt-bridge"))
        .map_err(|e| format!("bridge copy failed: {e}"))?;
    copy_file_if_exists(
        &bundled_root.join(BUNDLE_MANIFEST),
        &tmp.join(BUNDLE_MANIFEST),
    )
    .map_err(|e| format!("manifest copy failed: {e}"))?;
    validate_runtime_tree(&tmp)?;

    if runtime.exists() {
        fs::rename(runtime, &backup).map_err(|e| format!("runtime backup failed: {e}"))?;
    }
    if let Err(error) = fs::rename(&tmp, runtime) {
        if backup.exists() {
            let _ = fs::rename(&backup, runtime);
        }
        return Err(format!("runtime replace failed: {error}"));
    }
    let _ = fs::remove_dir_all(&backup);
    Ok(())
}

#[cfg(test)]
pub(crate) fn copy_fixture_runtime_from_bundle(
    bundled_root: &Path,
    runtime: &Path,
) -> Result<(), String> {
    copy_runtime_from_bundle(bundled_root, runtime)
}
