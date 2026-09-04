# Agent Note: `persona` for the Claude Code and Codex subagent providers

Status: implemented

English | [中文](2026-09-03-cli-subagent-persona.zh.md)

## Problem

The two subscription-CLI subagent providers advertised `NO_START_CAPABILITIES`, so the shared seam rejected every `persona` request before the provider saw it. In a deployment that composes several delegation tools into one roster, that made the CLI-backed members structurally unlike the in-process ones: an in-process child receives its persona as a scoped `deployment:persona` section, while a CLI child received nothing and its caller had to hand-write the role into every task text, then annotate each answer as unstyled. That is a per-call authoring burden belonging in the provider.

Both products can carry a per-child role; neither provider passed one.

## Decision

Advertise `persona: true` on both providers and route the requested text through each product's own mechanism. The mechanisms differ enough that the capability flag is the only thing they share.

### Claude Code — native preset, appended

The Agent SDK's `systemPrompt` accepts `{ type: 'preset', preset: 'claude_code', append }`. The provider uses that form, so a persona layers over the native Claude Code system prompt instead of replacing it. This preserves the package's existing stance that native settings and product configuration stay authoritative — the provider deliberately omits `settingSources`, and a persona that replaced the preset would silently undo that. With no persona the option is left unset rather than passed as an empty append, so a run without one is byte-identical to before.

### Codex — leading text block, not a system instruction

The app-server protocol has no custom system-prompt field. `thread/start` accepts `personality` (a predefined enum, not free text) and `turn/start` accepts `settings.developer_instructions` only under collaboration mode; neither can carry an arbitrary role. The persona therefore becomes the turn's leading text block.

This is a weaker guarantee than Claude Code's and is documented as such: the model may treat the persona as task content rather than as an instruction outranking the task. It is applied inside `textTask` *after* validation, so a persona cannot make an otherwise-empty task valid — the emptiness check still runs against the caller's blocks alone.

The asymmetry is deliberate rather than a missed extraction. A shared "prefix the persona" helper would hide that one provider gets a system instruction and the other gets task text, which is exactly the fact a caller needs when deciding how forcefully to phrase a role.

## Alternatives considered

**Leave the capability unadvertised and keep writing the role into the task text.** This is what callers did before, and it works — the model does read a role stated in the prompt. It loses on two counts. The role is re-authored per call rather than declared once per delegation tool, so a roster with several CLI members repeats it everywhere; and for Claude Code it forfeits a real system-prompt slot the SDK already offers, leaving the role at the same rank as the task when the product can rank it above.

**Replace the Claude Code preset instead of appending to it.** `systemPrompt` also accepts a bare string, which would give the persona total control of the system prompt and make both providers behave alike. Rejected: the package's whole stance is that native Claude Code settings, `CLAUDE.md`, and product configuration remain authoritative — the provider omits `settingSources` precisely so the host's own settings apply. A replacing persona would silently discard all of it, and the caller asking for a role has no way to know that is what they bought.

**Prefix the persona for Codex with a synthetic instruction wrapper** (`"System: …"`, or a fenced role block). Rejected as false precision: it dresses a task text block up as a system instruction without changing what the model actually receives, which makes the weaker guarantee harder to see rather than stronger. The README states the rank honestly instead.

**Extract a shared persona-application helper across both providers.** Rejected: the two mechanisms differ in the one property that matters to a caller — whether the persona outranks the task. A shared helper would hide exactly that. The symmetry here is the capability flag, and it is already shared.

## Consequences

A deployment can now declare a CLI child's role beside its in-process siblings, and both providers accept the same request field, so a roster's members become uniform at the seam even though their guarantees differ. That difference is the cost: `persona` is one boolean, but it now means "a system instruction" for one provider and "the first thing in the task" for the other. Both READMEs and this note carry that distinction, and a caller who needs the stronger guarantee must read them rather than trust the flag.

A run that supplies no persona is unchanged — Claude Code leaves `systemPrompt` unset rather than passing an empty append, and Codex returns the caller's blocks untouched — so the change cannot alter existing delegation behavior.

`turn/start.outputSchema` exists in the Codex protocol and remains unwired; the Claude Agent SDK's structured-output path was not surveyed. Enforcing a structured final result also requires result validation and failure-category mapping, which is a separate change with its own diagnostic surface. Both READMEs record that gap, so a caller still receives free-form text from these providers.

## Testing

Unit coverage at the two seams that changed. For Claude Code, `claudeQueryOptions` is asserted to produce the exact preset-append object with a persona and to omit the `systemPrompt` property entirely without one. For Codex, `textTask` is asserted to place the persona first, to leave the sequence untouched without one, and to still reject a blank task when a persona is supplied. Both providers' registration and loader-composition tests now assert `persona: true` in the advertised capability set — the flag and the passthrough must move together, because the seam rejects the request before the provider runs when the flag is absent.

No snapshot or e2e change: the delegation transcript is unchanged for a call that supplies no persona, and a call that supplies one reaches a real subscription CLI, which the keyless lanes do not run.
