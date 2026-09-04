# Agent Note: A configuration surface for subscription sign-ins

Status: implemented

English | [中文](2026-09-04-subscription-sign-in-surface.zh.md)

## Problem

A model picker offered only routes whose credential is a key someone types. The subscription plans a person already pays for — Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot, Kimi Code, SuperGrok, OpenRouter — were unreachable, so using one meant running its own CLI product beside the harness rather than picking its models like any other.

Nothing was missing from the libraries. `dsh-llm-pi-ai` already registers a sign-in flow per pi-ai catalog provider, and `dsh-authorization` already defines what a flow is and runs one attempt at a time. The seam was incomplete in one role: it had a Service Definition and a Provider and no Consumer, and no composition mounted the service at all. Every one of those flows existed and could not be reached.

## Decision

`dsh-authorization` mounts in the base bundle beside `credentials-local`, and `dsh-api-settings-controller` gains the `authorization` Remote namespace as the seam's Consumer.

The wire identity of a sign-in is its credential key, and the view carries the key's id segment as `subject`. A Models page knows provider route ids, not credential keys; `subject` is what lets it put a sign-in on the row it belongs to without the API package knowing which plugin minted the key.

One attempt is one stream. `start` yields `notice` frames for what to open, `prompt` frames for what to answer, and exactly one `settled` frame carrying `authorized`, `cancelled`, or `failed` — the three-way settlement the seam already distinguishes for onlookers, because a watcher that did not start the attempt cannot otherwise tell a refusal from a breakage. Answers return over the unary `answer(promptId, value)` rather than upstream on the same stream, which keeps the carrier one-directional.

Closing the stream withdraws the attempt and rejects every question still waiting. A pending `prompt()` is a promise held across the wire; without this a closed tab would leave the flow suspended forever, holding the one attempt slot the registry allows per key.

A synchronous refusal — an unmounted registry, a malformed key — is reported by an `async` method so it reaches the caller as a rejection. A `@Remote` method that throws before returning its promise is not a rejected call the client can catch.

## Alternatives considered

**Registering a step driver per CLI agent and publishing it as a route.** Rejected: it reimplements, one product at a time, what pi-ai's catalog already covers for every subscription at once, and a driven agent runs the CLI's own loop rather than the harness's — a different capability, not this one. That work stays where it is; it is not the answer to "let me pick these models".

**Reading the credentials another CLI already stored.** Rejected on inspection: omp keeps its grants in its own SQLite store, dsh in its credential document. Copying a grant between two stores that each refresh it is two writers on one rotating token.

**A `login` button that posts an API key.** Rejected: the settings page already writes credential *references*, and that is the key half. A subscription grant is a credential *record*, obtained by conversation; the two halves are complementary, so the key box stays and this is added beside it.

**Answering prompts upstream on the same stream.** Rejected: the Remote stream carrier is one-directional, and a second channel per attempt buys nothing a correlated unary call does not.

## Consequences

Every pi-ai catalog provider that ships a login is now reachable: 39 flows, six of them subscription OAuth.

A person can sign in from a configuration surface, and the granted route's models join the model catalog like any other provider's — which is what makes a subscription model selectable for any agent, preset, or council role.

The Client half is not built in this change: no button starts an attempt yet, so the namespace is reachable only by a direct caller. It is **未接线·不计入交付** until the Models page runs a sign-in.
