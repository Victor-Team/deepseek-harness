/**
 * One-shot omp run lifecycle: spawn the child, complete the RPC handshake,
 * publish the seam run, deliver one prompt, and tear the process tree down.
 *
 * @module @deepseek-ai/dsh-subagent-omp/run
 */

import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { settleRunResult, subprocessRunHandle } from '@deepseek-ai/dsh-subagent'
import type {
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { OmpRpcClient } from './rpc.ts'

/** Default grace after stdin EOF before the termination escalation begins. */
export const DEFAULT_DISPOSE_EOF_GRACE_MS = 6000
/** Default POSIX grace between SIGTERM and SIGKILL on the process tree. */
export const DEFAULT_DISPOSE_GRACE_MS = 3000

/** Resolved spawn and policy inputs for one omp child; every default is applied by `Config`. */
export interface OmpRunSpec {
  /** The omp executable to spawn. */
  command: string
  /** Arguments preceding this package's own RPC-mode flags. */
  args: string[]
  /** Absolute working directory for the child process. */
  cwd: string
  /** Model id passed as `--model`; omission leaves omp's own selection in force. */
  model: string | undefined
  /** Explicit environment layered over the subprocess seam's scrubbed parent environment. */
  env: Record<string, string>
  /** Grace after stdin EOF before termination begins. */
  disposeEofGraceMs: number
  /** Grace between the process-tree termination tiers. */
  disposeGraceMs: number
  /** Spawn through the subprocess seam so the whole tree stays owned. */
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Diagnostic sink for a failure already flattened to a stop reason. */
  onError: (error: Error, stopReason: SubagentStopReason) => void
}

/**
 * Flags this package always supplies. `--mode rpc` selects the newline-delimited
 * protocol, and `--no-session` keeps the child ephemeral so a one-shot
 * delegation leaves no resumable omp session behind.
 */
const FIXED_ARGS = ['--mode', 'rpc', '--no-session'] as const

/**
 * Validate the delegated task and concatenate it into omp's single prompt field.
 *
 * The `prompt` command carries one string, so ordered text blocks are joined
 * rather than preserved as separate turns.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact concatenated task text.
 */
export function textTask(prompt: readonly ContentBlock[]): string {
  if (prompt.length === 0) {
    throw new Error('subagent-omp: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-omp: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-omp: the one-shot task must not be empty')
  }
  return texts.join('')
}

/**
 * Build the child's argv from the resolved spec.
 * @param spec - resolved command, arguments, and model selection.
 * @returns argv with this package's fixed RPC flags applied last.
 */
export function ompArgv(spec: OmpRunSpec): string[] {
  return [
    spec.command,
    ...spec.args,
    ...FIXED_ARGS,
    ...spec.model === undefined ? [] : ['--model', spec.model],
  ]
}

/** Bounded whole-tree exit wait: resolves false when `ms` elapses first. */
async function treeExitsWithin(child: SubprocessHandle, ms: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, ms)
  try {
    return await child.waitForExit(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Cooperative teardown over the subprocess seam's public verbs, resolving only
 * at whole-tree quiescence: stdin EOF gives omp its window to flush and reap
 * descendants, then `terminate()` owns the SIGTERM → grace → SIGKILL ladder.
 * @param child - the spawned omp child's handle.
 * @param eofGraceMs - the window granted after stdin EOF.
 */
export async function disposeOmpChild(child: SubprocessHandle, eofGraceMs: number): Promise<void> {
  if (child.pid <= 0) {
    // A spawn-level failure has no tree to tear down; observing the rejection
    // here keeps a `finally`-path disposal from surfacing it as unhandled.
    await child.done.catch(() => {})
    return
  }
  child.stdin?.end()
  if (await treeExitsWithin(child, eofGraceMs)) return
  child.terminate()
  await child.waitForExit()
}

/**
 * Start one omp child and publish its seam run.
 *
 * Fulfillment means the process is live and has announced its protocol, so
 * ownership has transferred to the caller. Any failure before that point tears
 * the tree down and rejects.
 * @param request - the resolved shared subagent request.
 * @param spec - resolved spawn, model, and disposal policy.
 * @returns the published run after the child's `ready` frame arrives.
 */
export async function startOmpRun(
  request: SubagentStartRequest,
  spec: OmpRunSpec,
): Promise<SubagentRun> {
  const message = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-omp: request was aborted before the child was spawned')
  }

  const argv = ompArgv(spec)
  const child = spec.spawn({
    argv,
    cwd: spec.cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: spec.disposeGraceMs,
    env: spec.env,
  })

  let processDisposal: Promise<void> | undefined
  const disposeProcess = (): Promise<void> => (processDisposal ??= disposeOmpChild(child, spec.disposeEofGraceMs))

  const { stdin, stdout } = child
  if (stdin === undefined || stdout === undefined) {
    await disposeProcess()
    throw new Error('subagent-omp: the spawned child exposed no stdio pipes')
  }

  const wire = new OmpRpcClient(stdin, stdout)
  try {
    await wire.whenReady(request.signal)
  } catch (error: unknown) {
    wire.close('startup failed')
    await disposeProcess()
    throw error
  }

  let cancelled = false
  let cancelSettle: (() => void) | undefined
  const cancelSettled = new Promise<void>((resolve) => { cancelSettle = resolve })
  const requestCancel = (): void => {
    cancelled = true
    wire.close('the run was cancelled')
    cancelSettle?.()
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  let output: ContentBlock[] = []
  const result = settleRunResult({
    attempt: async (): Promise<SubagentResult> => {
      const outcome = await Promise.race([
        wire.prompt(message, request.signal),
        cancelSettled.then((): never => {
          throw new Error('subagent-omp: cancelled while the omp prompt was running')
        }),
      ])
      if (outcome.text === undefined) {
        throw new Error('subagent-omp: the child completed its turn without a final answer')
      }
      output = [{ type: 'text', text: outcome.text }]
      return { stopReason: 'completed', output }
    },
    collectOutput: () => output,
    cancelled: () => cancelled,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: brandString<SessionId>(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: disposeProcess,
  })
}
