---
description: "The out-of-process omp subagent backend for users and maintainers delegating to an oh-my-pi child, selecting its model, or debugging remote child runs."
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-omp

English | [中文](README.zh.md)

## Summary

`dsh-subagent-omp` runs each delegated child as a fresh [omp](https://github.com/can1357/oh-my-pi) (oh-my-pi) process driven over omp's newline-delimited RPC protocol. The child brings its own runtime, tools, skills, and model routing, so a delegation reaches whatever providers that omp installation is authenticated for — including subscription-routed ones — without the harness holding those credentials. Each run spawns a process, waits for omp's `ready` frame, sends one prompt, waits for the terminal turn, and returns the child's final answer through the shared subagent result contract. The parent receives only that answer or a safe error; omp's reasoning, tool activity, and stderr never cross the boundary. Choose it when the child should be a real omp session with omp's own model catalog, fully isolated from the parent harness.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this provider when a composition needs an isolated child backed by omp's model routing. The path is explicit: mount the seam, mount this provider, and expose it to the model through a delegation tool row.

### When to choose it

Choose omp over the in-process backends when the child should run under a different model than the parent's provider route offers, or when omp's own tools and skills are what the task needs. Choose an in-process backend instead when the child must share the parent's tool registry, persona composition, or session lineage — this provider shares none of them.

The child's model catalog is whatever the spawned omp installation resolves, which depends on that installation's own configuration and authentication. A provider row naming a model omp cannot resolve fails at run time, not at load.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `omp` | Non-empty registry name on `ctx.subagents`; each mounted instance needs a unique value |
| `command` | `omp` | The omp executable; resolved through the host `PATH` unless absolute |
| `args` | `[]` | Arguments placed before this package's fixed RPC-mode flags |
| `cwd` | parent session cwd | Working-directory override; a relative value resolves against the harness launch directory at load |
| `model` | omp's own selection | Model id passed as `--model`; omission leaves omp's configured roles and profile defaults in force |
| `env` | `{}` | Explicit child environment layered over the credential-scrubbed parent environment |
| `disposeEofGraceMs` | `6000` | Grace after stdin EOF before process-tree termination begins |
| `disposeGraceMs` | `3000` | Grace between the process-tree termination tiers |

Every run appends `--mode rpc --no-session`. The RPC mode selects the protocol this provider speaks; `--no-session` keeps the child ephemeral, so a one-shot delegation leaves no resumable omp session on disk.

`command` deliberately defaults to a bare `omp` rather than an absolute path: which installation answers is a deployment decision, and a wrapper script that pins a profile or model is a legitimate choice. Note that such a wrapper also narrows the model catalog — a profile alias sees only the providers that profile configured.

```yaml
- id: subagent-omp
  name: '@deepseek-ai/dsh-subagent-omp'
  config:
    providerName: omp
    model: anthropic/claude-opus-5
- id: tool-subagent-omp
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: omp
    toolName: subagent_omp
    backgroundMode: one-shot
    maxDepth: provider-managed
```

### What you get

A foreground call hands the model omp's final assistant text; a failed run returns the stop reason with an optional safe diagnostic. A background call returns a Job id first, and the generic job controls deliver the same final answer through `job_output`.

### Failure and recovery

A missing or unstartable `command`, a child that exits before its `ready` frame, or a stream that closes mid-turn all fail the run with a safe message; the process tree is torn down before the rejection surfaces. A child that completes its turn without producing text settles as an error rather than an empty success. Cancellation settles as `aborted`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation detail — click to expand</summary>

### Design commitments

- **A fresh process per run.** No pooling, no session reuse, no resume. One omp process serves exactly one delegated task and is torn down with it.
- **omp's configuration is authoritative.** The provider overrides only `--model` and the fixed RPC flags. Model catalogs, authentication, tools, skills, and every other product setting stay native to that omp installation.
- **Protocol version 1 only.** omp announces `supportedProtocolVersions: [1, 2]` and defaults to 1. Version 2 adds `rpc_chunk` splitting for frames above the transport ceiling, which a run that returns one final answer does not need. The client rejects a chunk frame rather than reassembling a partial one, so a future default change fails loudly instead of truncating an answer.

### Source map

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, provider registration |
| [`src/rpc.ts`](src/rpc.ts) | The omp RPC client: framing, command correlation, terminal-turn detection |
| [`src/run.ts`](src/run.ts) | Run lifecycle: spawn, handshake, publication, teardown ladder |

### Run flow

A start accepts only text blocks, joins them into omp's single `prompt` string, and derives the child cwd from the parent session. It spawns through the subprocess seam, constructs the RPC client over the child's stdio, and publishes the run only after omp's `ready` frame arrives — so fulfillment means the child is live and speaking. The published result sends one `prompt` command, waits for the terminal turn, then reads the answer with `get_last_assistant_text`.

**`agent_end` is not always terminal.** omp sets `willContinue: true` on an `agent_end` whose session has already scheduled an automatic continuation (auto-retry, empty-stop retry); its own protocol documentation states that subscribers must not treat that as a settle. The client therefore waits for an `agent_end` without that flag. Treating the first one as terminal would return a half-finished answer whenever omp retried.

Teardown is the same cooperative ladder the sibling out-of-process backends use: stdin EOF gives omp its window to flush and reap descendants, then `terminate()` owns the SIGTERM → grace → SIGKILL escalation and its whole-tree exit proof.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — service contract, provider contract, terminal result semantics.
- [dsh-subagent seam](../subagent/README.md) — the registry and start API this provider registers on.
- [ACP subagent provider](../subagent-acp/README.md) — the sibling out-of-process backend for ACP-speaking children.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-omp) — every accepted field and its source declaration.

-----

<a id="dev-note"></a>
## Dev Note

The omp RPC protocol is not JSON-RPC, so this package does not share the transport used by the Codex backend. Its client is intentionally minimal: it acts on `ready`, `response`, `agent_end`, and `rpc_chunk`, and ignores every other event frame, because a one-shot delegation needs only the terminal turn and the final answer. Widening it — for streaming projection, host tools, or continuable children — is a design change, not an incremental one, and belongs with the seam work that would consume those frames.

-----

<a id="model-experience"></a>
## Model Experience

### Child request

#### What the model sees

The omp child receives the concatenated text task as one prompt in a fresh ephemeral session. Its workspace is the parent session cwd; the selected provider instance fixes the configured model and environment, while an omitted model and every other product setting come from that omp installation's own configuration. The child has omp's tools and skills, not the harness's.

#### Token effect

The child pays for an independent omp context and turn. Child tokens do not enter the parent's context.

#### KV Cache effect

Independent of the parent request cache. Reuse depends only on omp's own model, instructions, tools, and fresh session.

### Parent scheduling and results, indirectly

#### What the model sees

Through `dsh-tool-subagent`, a foreground call gives the parent omp's final assistant text, or an error carrying the stop reason and any safe diagnostic. A background call returns a Job id first; the generic job controls later deliver a completion notice and expose the same answer through `job_output`. omp's reasoning, tool activity, intermediate messages, stderr, and workspace diffs are not copied into the parent session.

#### Token effect

Foreground input grows by the retained final answer or error. Background input also includes the start acknowledgement, completion notice, and any later job results. This provider adds no parent tool schema by itself.

#### KV Cache effect

Append-only: foreground adds one result after the reusable parent prefix, while background appends the acknowledgement, notice, and later control results. None of them rewrites the earlier prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No optional shared capabilities** — `agentOptions`, output schemas, child personas, tool filtering, and harness depth enforcement are rejected by the shared service for this provider. omp exposes `--append-system-prompt`, which would carry a persona, but it takes a file path rather than inline text and no run currently writes one.
- **One prompt per connection** — the client refuses a second concurrent prompt on the same wire. This matches the one-shot delegation it serves; omp's `steer`, `follow_up`, and continuable-session commands are not wired.
- **Protocol v1 only** — an answer larger than omp's single-frame transport ceiling fails rather than reassembling v2 chunk frames.
- **The child's reach is that installation's, not the harness's** — the models a delegation can use, and whether any subscription provider is authenticated at all, are properties of the spawned omp installation. The harness neither inspects nor manages that state, so a deployment expecting a subscription-routed model must ensure that installation is logged in.
- **No elapsed-time timeout or side-effect rollback** — long-running work is cancelled by the caller, and files or external systems changed before cancellation are not restored.

**Runtime invariant:** No companion is published. This package owns no event sequence or mutable data relation of its own: turn settlement is the omp child's, lifecycle pairing belongs to the shared subagent service, and process-tree ownership belongs to the subprocess service.
