const { readString } = require("../_shared/translator-utils");

function createOpencodeApprovalFlow({ approvalIdToPermission, getActiveThreadId, getActiveTurnId, injectInbound, transport }) {
function handlePermissionAsked(envelope) {
  // opencode top-level shape (from the SDK code): the event payload is the
  // permission object directly under `properties` (not wrapped). Defensive
  // about both layouts.
  const props = envelope?.properties || {};
  const perm = props?.info && typeof props.info === "object" ? props.info : props;
  const permissionID = readString(perm?.id) || readString(perm?.permissionID);
  if (!permissionID) return;
  const sessionID = readString(perm?.sessionID) || getActiveThreadId();
  if (sessionID !== getActiveThreadId()) return;

  const kind = readString(perm?.permission) || "command";
  const metadata = perm?.metadata && typeof perm.metadata === "object" ? perm.metadata : {};
  const requestId = `approval_${permissionID}`;
  approvalIdToPermission.set(String(requestId), { permissionID, sessionID });

  const isFileChange = kind === "edit" || kind === "write" || kind === "patch";
  const requestMethod = isFileChange
    ? "item/fileChange/requestApproval"
    : "item/commandExecution/requestApproval";

  injectInbound(JSON.stringify({
    id: requestId,
    method: requestMethod,
    params: {
      threadId: getActiveThreadId(),
      turnId: getActiveTurnId(),
      kind,
      command: readString(metadata.command) || readString(perm?.tool) || "",
      cwd: readString(metadata.cwd) || readString(perm?.directory) || "",
      file_path: readString(metadata.filepath) || readString(metadata.file_path) || "",
      diff: readString(metadata.diff) || "",
      reason: readString(perm?.title) || readString(perm?.description) || "",
      permissionID,
    },
  }));
}

async function handleApprovalReply(reply) {
  const requestId = String(reply.id);
  const tracked = approvalIdToPermission.get(requestId);
  if (!tracked) return; // not an approval reply we issued
  approvalIdToPermission.delete(requestId);

  const decision = readString(reply?.result?.decision)
    || readString(reply?.result?.response)
    || (reply?.error ? "reject" : "");
  // iOS uses Codex's "accept"/"decline"/"reject"; opencode wants
  // "once"|"always"|"reject" (and optionally other optionIds).
  let response;
  if (decision === "accept" || decision === "approve" || decision === "once") {
    response = "once";
  } else if (decision === "always") {
    response = "always";
  } else {
    response = "reject";
  }

  try {
    await transport.httpRequest(
      "POST",
      `/session/${encodeURIComponent(tracked.sessionID)}/permissions/${encodeURIComponent(tracked.permissionID)}`,
      { sessionID: tracked.sessionID, permissionID: tracked.permissionID, response },
    );
  } catch {
    // Best-effort; the assistant will surface a tool failure if the POST
    // didn't land.
  }
}


  return {
    handlePermissionAsked,
    handleApprovalReply,
  };
}

module.exports = {
  createOpencodeApprovalFlow,
};
