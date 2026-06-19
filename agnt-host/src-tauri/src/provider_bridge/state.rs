use std::sync::Mutex;

use serde::Serialize;
use tokio::{sync::oneshot, task::JoinHandle};

use super::{
    config::ProviderBridgeConfig,
    errors::ProviderBridgeError,
    server::{self, RunningProviderBridge},
};

#[derive(Clone, Debug, Serialize)]
pub struct ProviderBridgeStatus {
    pub running: bool,
    pub bind_host: String,
    pub port: u16,
    pub base_url: String,
    pub provider: String,
}

struct ActiveBridge {
    shutdown_tx: oneshot::Sender<()>,
    task: JoinHandle<Result<(), std::io::Error>>,
    config: ProviderBridgeConfig,
}

#[derive(Default)]
pub struct ProviderBridgeRuntime {
    active: Mutex<Option<ActiveBridge>>,
}

impl ProviderBridgeRuntime {
    pub async fn start(
        &self,
        config: ProviderBridgeConfig,
        api_key: String,
    ) -> Result<ProviderBridgeStatus, ProviderBridgeError> {
        {
            let active = self
                .active
                .lock()
                .map_err(|_| ProviderBridgeError::AlreadyRunning)?;
            if active.is_some() {
                return Err(ProviderBridgeError::AlreadyRunning);
            }
        }

        let RunningProviderBridge { shutdown_tx, task } =
            server::start(config.clone(), api_key).await?;

        let mut active = self
            .active
            .lock()
            .map_err(|_| ProviderBridgeError::AlreadyRunning)?;
        *active = Some(ActiveBridge {
            shutdown_tx,
            task,
            config: config.clone(),
        });
        Self::status_from_config(true, &config)
    }

    pub async fn stop(&self) -> Result<ProviderBridgeStatus, ProviderBridgeError> {
        let active = {
            let mut guard = self
                .active
                .lock()
                .map_err(|_| ProviderBridgeError::NotRunning)?;
            guard.take().ok_or(ProviderBridgeError::NotRunning)?
        };

        let config = active.config.clone();
        let _ = active.shutdown_tx.send(());
        active.task.await??;
        Self::status_from_config(false, &config)
    }

    pub fn status(
        &self,
        fallback_config: &ProviderBridgeConfig,
    ) -> Result<ProviderBridgeStatus, ProviderBridgeError> {
        let guard = self
            .active
            .lock()
            .map_err(|_| ProviderBridgeError::NotRunning)?;
        if let Some(active) = guard.as_ref() {
            Self::status_from_config(true, &active.config)
        } else {
            Self::status_from_config(false, fallback_config)
        }
    }

    fn status_from_config(
        running: bool,
        config: &ProviderBridgeConfig,
    ) -> Result<ProviderBridgeStatus, ProviderBridgeError> {
        Ok(ProviderBridgeStatus {
            running,
            bind_host: config.bind_host.clone(),
            port: config.port,
            base_url: config.base_url()?,
            provider: config.provider.clone(),
        })
    }
}
