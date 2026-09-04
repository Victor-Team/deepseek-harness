# Agent Note: The omp subagent backend

Status: implemented

English | [中文](2026-09-03-omp-subagent-backend.zh.md)

## Problem

A deployment that wants a delegated child on a model the parent's provider route does not offer has two out-of-process options today, and both constrain the model choice to what the harness itself can reach: the ACP backend needs an ACP-speaking child, and the Claude Code and Codex backends each bind one product. None of them lets a composition delegate to an arbitrary model catalog held by a third-party CLI.

[omp](https://github.com/can1357/oh-my-pi) resolves models across many providers from one installation, including subscription-routed ones the harness holds no credentials for. Reaching it needs a backend that speaks its protocol.

## Decision

Add `dsh-subagent-omp`, a one-shot out-of-process provider that spawns `omp --mode rpc --no-session` and drives the child over omp's newline-delimited RPC protocol. It joins the seam beside the ACP, Claude Code, and Codex backends, sharing their contract: a fresh process per run, the parent session cwd as the workspace, and only the child's final answer crossing back.

### Protocol version 1, deliberately

omp announces `supportedProtocolVersions: [1, 2]` in its `ready` frame and defaults to 1. Version 2 adds `rpc_chunk` splitting for frames above the transport ceiling. A run that sends one prompt and reads one final answer does not need reassembly, so the client speaks v1 and treats a chunk frame as a protocol fault. Silently reassembling would mean carrying partial-frame state for a case this provider does not serve; failing loudly means a future default change surfaces as an error rather than a truncated answer.

### `agent_end` is not the settle signal

omp sets `willContinue: true` on an `agent_end` whose session has already scheduled an automatic continuation — auto-retry, empty-stop retry — and its own protocol types state that subscribers must not treat that as a user-visible terminal settle. The client therefore waits for an `agent_end` without the flag.

This is the one place where a plausible reading of the protocol produces a silent correctness bug: treating the first `agent_end` as terminal returns whatever text existed at the moment omp decided to retry, which looks like a complete answer and is not.

### The final answer comes from `get_last_assistant_text`

After the terminal turn the client issues one `get_last_assistant_text` command rather than folding the streamed `text_delta` and `message` frames. omp already computes that selection, so folding the stream would reimplement its answer-selection rule and drift from it. The client consequently acts on four frame types and ignores every other event.

## Alternatives considered

**Register omp as an LLM adapter on `ctx.llm` instead of a subagent provider.** This was investigated first, because it would make omp's models selectable anywhere the harness routes a model. It does not work: omp's `prompt` command carries a single `message` string with no structured message array, and the host tools omp accepts through `set_host_tools` are wrapped as omp's *own* agent tools — omp runs its loop over them and continues after each result until `agent_end`. One `prompt` is therefore a whole agent turn, not one model request, and `llm.stream()` cannot be satisfied by it without dissolving the harness's own step boundaries.

**Fold the streamed frames instead of asking for the final text.** The stream carries `message`, `text_delta`, and `output_text` frames, so the answer can be accumulated. Rejected: omp's own answer selection is authoritative and already exposed as a command; reimplementing it here would produce a second selection rule that silently disagrees with the product's whenever omp changes its own.

**Speak protocol v2 and reassemble chunks.** Rejected as speculative for this provider — see the decision above. It becomes correct when a consumer needs frames larger than the ceiling, which a one-shot final answer does not.

**Reuse the Codex backend's JSON-RPC transport.** Rejected because omp's protocol is not JSON-RPC: it correlates commands by an `id` field on flat command and response frames and interleaves uncorrelated event frames. The shared transport models neither, so reuse would mean bending it to a second protocol rather than sharing one.

## Consequences

A composition can now delegate to any model the spawned omp installation resolves, without the harness holding those credentials or knowing that catalog. The cost is that the reachable models become a property of an installation the harness does not manage: a deployment expecting a subscription-routed model must ensure that installation is authenticated, and a `command` pointing at a profile-scoped wrapper silently narrows the catalog to that profile's providers. The README states both.

The provider advertises no optional capabilities. omp's `--append-system-prompt` could carry a persona, but it takes a file path rather than inline text, so supporting it means writing a per-run temporary file — deferred rather than half-done.

The client acts on four frame types and ignores the rest, which is sufficient for a one-shot answer and insufficient for anything that needs to observe the child's work. Streaming projection, host-tool passthrough, and continuable children each need the client widened, and each belongs with the seam work that would consume those frames.

## Testing

Unit coverage over the client's framing and terminal-turn rules, and over the run lifecycle's validation and argv construction. The protocol-level assertions are what matter: a `willContinue: true` `agent_end` must not settle a prompt, a chunk frame must fail the wire rather than be reassembled, and a response frame must reject its correlated waiter when `success` is not true. A mock child exercising the wire covers these without spawning omp.

No keyless snapshot: a real run reaches a third-party CLI whose model catalog and authentication are host state, which the keyless lanes deliberately do not depend on.
