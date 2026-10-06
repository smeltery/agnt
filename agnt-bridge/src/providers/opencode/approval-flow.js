const { readString } = require("../_shared/translator-utils");

function createOpencodeApprovalFlow({ approvalIdToPermission, getActiveThreadId, getActiveTurnId, injectInbound, transport }) {
  const emit = (method, params, id) => injectInbound(JSON.stringify({ ...(id ? { id } : {}), method, params }));
  function handleAsked(envelope, kind) {
    const props = envelope?.properties || {};
    const request = props.info && typeof props.info === "object" ? props.info : props;
    const remoteId = readString(request.id) || readString(request.permissionID);
    const sessionID = readString(request.sessionID) || getActiveThreadId();
    if (!remoteId || !sessionID || sessionID !== getActiveThreadId()) return;
    const id = `${kind === "permission" ? "approval" : "question"}_${remoteId}`;
    const existing = approvalIdToPermission.get(id);
    const questions = (Array.isArray(request.questions) ? request.questions : []).map((question, index) => ({
      ...question, id: readString(question.id) || `question-${index}`,
      isOther: question.custom !== false,
    }));
    const tracked = { kind, remoteId, sessionID, request, questions, submitting: existing?.submitting || false };
    approvalIdToPermission.set(id, tracked);
    const metadata = request.metadata || {};
    const permission = readString(request.permission) || "command";
    const fileChange = ["edit", "write", "patch"].includes(permission);
    const params = {
      threadId: sessionID, turnId: getActiveTurnId(), itemId: request.tool?.callID || remoteId,
      ...(kind === "question" ? { questions } : {
        kind: permission, permissionID: remoteId,
        command: readString(metadata.command) || (request.patterns || []).join(" ") || permission,
        cwd: readString(metadata.cwd) || readString(request.directory),
        file_path: readString(metadata.filepath) || readString(metadata.file_path),
        diff: readString(metadata.diff), reason: readString(request.title) || readString(request.description),
      }),
    };
    tracked.method = kind === "question" ? "item/tool/requestUserInput"
      : fileChange ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval";
    tracked.params = params;
    emit(tracked.method, params, id);
  }

  function resolve(id, tracked) {
    if (approvalIdToPermission.get(id) !== tracked) return;
    approvalIdToPermission.delete(id);
    emit("serverRequest/resolved", { requestId: id, threadId: tracked.sessionID });
  }

  async function handleApprovalReply(reply) {
    const id = String(reply.id);
    const tracked = approvalIdToPermission.get(id);
    if (!tracked || tracked.submitting) return;
    tracked.submitting = true;
    const cwd = transport.getSession(tracked.sessionID)?.directory;
    try {
      if (tracked.kind === "permission") {
        const raw = reply.result?.decision ?? reply.result?.response?.decision ?? reply.result?.response ?? reply.result;
        const decision = String(raw || "").toLowerCase();
        const response = ["acceptforsession", "always"].includes(decision) ? "always"
          : ["accept", "approve", "once"].includes(decision) ? "once" : "reject";
        try {
          await transport.httpRequest("POST", `/permission/${encodeURIComponent(tracked.remoteId)}/reply`, { reply: response }, cwd);
        } catch (error) {
          if (error.status !== 404) throw error;
          await transport.httpRequest("POST", `/session/${encodeURIComponent(tracked.sessionID)}/permissions/${encodeURIComponent(tracked.remoteId)}`,
            { response }, cwd);
        }
      } else if (reply.error) {
        await transport.httpRequest("POST", `/question/${encodeURIComponent(tracked.remoteId)}/reject`, undefined, cwd);
      } else {
        const source = reply.result?.answers ?? reply.result?.response?.answers ?? reply.result ?? {};
        const list = Array.isArray(source) ? source : tracked.questions.map((question) =>
          source[question.id]?.answers ?? source[question.id] ?? []);
        const answers = list.map((answer) => (Array.isArray(answer) ? answer : [answer]).map(String));
        await transport.httpRequest("POST", `/question/${encodeURIComponent(tracked.remoteId)}/reply`, { answers }, cwd);
      }
      resolve(id, tracked);
    } catch (error) {
      if (approvalIdToPermission.get(id) !== tracked) return;
      tracked.submitting = false;
      emit("system/notice", { threadId: tracked.sessionID, provider: "opencode", severity: "error",
        title: "Response could not be delivered", message: error.message });
      emit(tracked.method, tracked.params, id);
    }
  }

  function handleResolved(envelope) {
    const props = envelope.properties?.info || envelope.properties || {};
    const prefix = envelope.type.startsWith("question.") ? "question" : "approval";
    const id = `${prefix}_${props.id || props.permissionID || props.requestID || ""}`;
    const tracked = approvalIdToPermission.get(id);
    if (tracked && (!props.sessionID || props.sessionID === tracked.sessionID)) resolve(id, tracked);
  }

  return {
    handlePermissionAsked: (envelope) => handleAsked(envelope, "permission"),
    handleQuestionAsked: (envelope) => handleAsked(envelope, "question"),
    handleApprovalReply, handleResolved,
  };
}

module.exports = { createOpencodeApprovalFlow };
