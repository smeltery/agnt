// FILE: notifications-handler.js
// Purpose: Intercepts notifications/push/* bridge RPCs and forwards device registration to the configured push service.
// Layer: Bridge handler
// Exports: createNotificationsHandler
// Depends on: ./handler-utils

const { createJsonRpcRequestHandler } = require("./handler-utils");

function createNotificationsHandler({ pushServiceClient, logPrefix = "[agnt]" } = {}) {
  const handleNotificationsRequest = createJsonRpcRequestHandler({
    match: (method) => method === "notifications/push/register",
    dispatch: handleNotificationsMethod,
    defaultErrorCode: "push_registration_failed",
    defaultErrorMessage: "Push registration failed.",
    onError: (error) => {
      console.error(`${logPrefix} push registration failed: ${error?.message || error}`);
    },
  });

  async function handleNotificationsMethod(method, params) {
    if (!pushServiceClient?.hasConfiguredBaseUrl) {
      return { ok: false, skipped: true, completionPushEnabled: false };
    }

    const deviceToken = readString(params.deviceToken);
    const alertsEnabled = Boolean(params.alertsEnabled);
    const apnsEnvironment = readAPNsEnvironment(params.appEnvironment);
    if (!deviceToken) {
      throw notificationsError(
        "missing_device_token",
        "notifications/push/register requires a deviceToken."
      );
    }

    const registration = await pushServiceClient.registerDevice({
      deviceToken,
      alertsEnabled,
      apnsEnvironment,
    });

    return {
      ok: registration?.ok === true,
      skipped: registration?.skipped === true,
      completionPushEnabled: registration?.ok === true
        && registration?.skipped !== true
        && alertsEnabled
        && registration?.pushEnabled === true,
      alertsEnabled,
      apnsEnvironment,
    };
  }

  return {
    handleNotificationsRequest,
  };
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readAPNsEnvironment(value) {
  return value === "development" ? "development" : "production";
}

function notificationsError(errorCode, userMessage) {
  const error = new Error(userMessage);
  error.errorCode = errorCode;
  error.userMessage = userMessage;
  return error;
}

module.exports = {
  createNotificationsHandler,
};
