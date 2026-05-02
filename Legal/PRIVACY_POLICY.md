# agnt — Privacy Notice

**Last updated:** May 2, 2026

agnt is open-source software ([Apache-2.0](../LICENSE)). This notice describes how the reference implementation handles data when you run it yourself on your own infrastructure. There is no agnt-operated cloud service; you are the operator of any deployment you create.

If you redistribute agnt or run it as a service for other users, you are responsible for publishing your own privacy notice that reflects your specific operational choices.

---

## 1. Local-first by default

agnt is designed so the work happens on hardware you control:

- The bridge runs on your Mac.
- The agent CLI (Codex, Claude Code, opencode, ...) runs on your Mac.
- Conversation contents, repository actions, and workspace data live on your Mac and your iPhone.
- The reference relay can be run locally (`run-local-agnt.sh`) or on a server you control.
- The codebase contains no analytics, telemetry, advertising SDK, or behavioral tracking pipeline. Nothing in this repository sends usage data to a maintainer-operated endpoint.

## 2. What stays on your devices

**On your iPhone (when you build and install the iOS app):**

- Cryptographic identity material used for pairing and trusted reconnect (Keychain).
- Locally-cached chat history, encrypted with a Keychain-backed key.
- Pairing state, relay connection metadata, and UI preferences.
- Temporary voice recordings during capture and transcription.

**On your Mac:**

- Bridge daemon state (`~/.agnt/` by default).
- Agent CLI session state in the provider's home directory (e.g. `~/.codex/`).
- Anything the agent reads or writes on your local filesystem when you grant it access.

## 3. What can leave your devices

These flows only happen when you actively use them:

- **iPhone ↔ Mac transport.** After the secure handshake, payloads are end-to-end encrypted between the two devices. A relay (local or self-hosted) sees connection metadata and the encrypted envelope, not the contents.
- **Voice transcription (optional).** If you use voice mode, the iPhone uploads the recorded audio directly to OpenAI/ChatGPT using a token resolved from your Mac's local ChatGPT auth. The relay is not involved. See [openai.com/privacy](https://openai.com/privacy).
- **Agent network calls.** The agent CLI you choose may make its own network requests (model API calls, web searches, etc.). Those are governed by that agent's terms — agnt does not interpose.
- **Git operations.** When you trigger commits, pushes, or other git actions, the Mac performs them against whatever remotes you've configured.
- **Push notifications (optional, self-hosted).** Push delivery is off by default. If you enable it, you provide your own APNs credentials and operate the push service yourself.

## 4. Third-party libraries shipped with the iOS app

The iOS source includes optional integrations such as RevenueCat (subscription management) and StoreKit (in-app purchase). These are inert unless you configure the corresponding services for your own build (e.g. supplying RevenueCat API keys). If you do enable them in a build you distribute, the corresponding third-party privacy policies apply.

## 5. Data retention

Locally-stored data persists until you remove it. Deleting the iOS app removes container files; Keychain items may persist according to iOS rules. The bridge's `~/.agnt/` directory persists until you delete it. agnt itself does not retain anything off-device.

## 6. Your responsibilities as the operator

If you deploy agnt for others to use — for example by hosting the relay publicly, or by distributing your own iOS build — you are responsible for:

- Legal compliance in your jurisdiction (GDPR, CCPA, etc.).
- A privacy notice that describes your specific deployment.
- Operational security, including how you store APNs credentials and any private package defaults.

## 7. Source and contact

- **Source:** [github.com/dotbrains/agnt](https://github.com/dotbrains/agnt)
- **Issues / questions:** open an issue in the repository.

Upstream attribution is recorded in the project [README](../README.md).
