# agnt — Source Code Terms

**Last updated:** May 6, 2026

agnt is source-available software distributed under the [PolyForm Shield License 1.0.0](../LICENSE). These notes summarize how the source is offered. The `LICENSE` file is the authoritative legal text — if anything here disagrees with it, the license wins.

---

## 1. License

You may use, copy, modify, and distribute agnt under the terms of PolyForm Shield 1.0.0. The two practical conditions to know:

- **Non-compete.** You may not use the software to provide a product or service that competes with agnt or with any product or service the licensor (dotbrains) offers that includes agnt. Self-hosting agnt for your own use is fine; reselling a hosted agnt-equivalent is not.
- **Notices stay intact.** You must not remove or obscure the copyright, license, or attribution notices, and you must include a copy of the license with any distribution or derivative work.

The license includes the standard "AS IS" disclaimer of warranties and liability, which applies in full.

agnt was forked from a project originally released under Apache-2.0. Code that originated upstream remains available under that grant for anyone who pulled it (the `NOTICE` files record the attribution); new agnt contributions are released under PolyForm Shield 1.0.0.

## 2. No operator-run service

There is no agnt-operated cloud, relay, account system, or paid tier. agnt is intended to be run by you, on your own hardware. The reference relay can be run locally or on infrastructure you host yourself.

## 3. No support obligation

The maintainers provide no support, SLA, or guarantee that issues will be triaged or fixed. Patches and reports are welcome via the GitHub repository.

## 4. Your responsibilities

If you run, redistribute, or build on top of agnt, you are responsible for:

- The behavior of your deployment, including any data it processes.
- Compliance with applicable laws in your jurisdiction.
- The terms of any third-party services you connect (Codex, Claude, OpenAI, RevenueCat, APNs, etc.).
- Operational security of any credentials, keys, and private build defaults you use.
- Publishing your own privacy notice and terms if you offer agnt — or anything built from it — to other users.
- Honoring the PolyForm Shield non-compete clause described in section 1.

## 5. Trademarks

PolyForm Shield 1.0.0 does not grant trademark rights. The "agnt" and "dotbrains" names and any associated marks are not licensed for use beyond what is necessary to refer to the project (for example, in attribution).

## 6. Source

[github.com/dotbrains/agnt](https://github.com/dotbrains/agnt). Upstream attribution is recorded in the project [README](../README.md).
