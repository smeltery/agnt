# Provider: opencode

Run `agnt up --provider opencode` to use an installed local `opencode serve` runtime. The bridge translates the shared client protocol into REST requests and consumes the global SSE stream. No hosted agnt service is required.

## Models and chat settings

The model picker reads the runtime's connected providers through `model/list`. Model IDs include the provider (`provider/model`); reasoning choices retain the runtime's exact variant IDs, including custom variants. An explicitly empty variant catalog disables effort choices for that model.

Each chat keeps its own model and effort selection. An omitted effort inherits that chat's selection; an explicit null clears it. When no model is selected, the local runtime chooses its configured default. Creating a chat uses its local working directory, and subsequent requests retain the session's directory. Names and archive changes are saved through the runtime and report errors if saving fails.

## Requests and events

| Client operation | Local runtime operation |
|---|---|
| `model/list` | `GET /provider` |
| `thread/start` | `POST /session` with directory context |
| `thread/read`, `thread/resume` | Session details and message history |
| `thread/name/set`, archive/unarchive | `PATCH /session/<id>` |
| `turn/start` | `POST /session/<id>/prompt_async` with a stable message ID, model, variant and input parts |
| `turn/interrupt` | `POST /session/<id>/abort` |
| `thread/compact/start` | `POST /session/<id>/summarize` |
| `thread/fork` | `POST /session/<id>/fork` |

Text and reasoning deltas remain separate, including when full snapshots repeat or replace streamed content. Tool events retain the running chat and turn IDs. Reading another chat does not change the active turn. Retry status keeps the turn active; an explicit failure or idle status settles it. A second send while a turn is active returns `-32003`.

The SSE connection reconnects with bounded backoff. After reconnecting, the bridge checks the active session's status and history to recover missed output or completion. Newer live events invalidate slow recovery snapshots, and a failed status read does not mark work complete.

## Permissions and questions

Permission requests become `item/commandExecution/requestApproval` or `item/fileChange/requestApproval`. Responses map to `once`, `always` or `reject` and are posted to `/permission/<id>/reply`. Servers without that endpoint use the session-scoped permission endpoint.

Questions become `item/tool/requestUserInput`, with stable question IDs and ordered, multi-select answers. Answers and cancellations use `/question/<id>/reply` and `/question/<id>/reject`. Successful replies and resolutions from another client emit `serverRequest/resolved`. Failed deliveries show an error and keep the request retryable.

`system/notice` also carries runtime toasts, including MCP authentication warnings.

## Capabilities and implementation

Runtime approvals, questions, reasoning, model discovery, compact and fork are supported. Active-turn steering, Desktop mirroring, and Codex account or voice RPCs are unavailable. Coding-agent authentication remains managed by the local CLI.

Provider code lives under `agnt-bridge/src/providers/opencode/`: `translate.js` dispatches protocol messages; thread, stream, recovery, model and approval modules own their respective behavior; `transport.js` and `event-stream.js` handle the local process, HTTP and SSE. Regression tests live under `agnt-bridge/test/providers/opencode/`.

See [provider architecture](../architecture/translator-shim.md) and the [opencode server API](https://opencode.ai/docs/server/).
