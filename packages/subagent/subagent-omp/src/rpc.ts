/**
 * Minimal client for the omp (oh-my-pi) newline-delimited RPC protocol.
 *
 * The child speaks JSONL on stdio: it announces itself with one `ready` frame,
 * accepts command frames, answers each with a correlated `response` frame, and
 * emits uncorrelated event frames while a prompt runs. This module owns framing,
 * command correlation, and terminal-turn detection; product policy lives in
 * `run.ts`.
 *
 * Only protocol version 1 is spoken. Version 2 adds `rpc_chunk` splitting for
 * frames above the transport ceiling, which a one-shot delegation returning a
 * final answer does not need; the client rejects a chunk frame rather than
 * silently reassembling a partial one.
 *
 * @module @deepseek-ai/dsh-subagent-omp/rpc
 */

import type { Readable, Writable } from 'node:stream'

/** Frames the child sends that this client acts on. */
type JsonObject = Record<string, unknown>

/** Terminal outcome of one prompt, as observed on the wire. */
export interface OmpTurnOutcome {
  /** The child's final assistant text, or `undefined` when it produced none. */
  readonly text: string | undefined
}

/** Why the wire stopped serving before a prompt reached its terminal frame. */
export class OmpWireError extends Error {
  constructor(message: string) {
    super(`subagent-omp: ${message}`)
    this.name = 'OmpWireError'
  }
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

/**
 * One live omp RPC connection over an already-spawned child's stdio.
 *
 * The client is single-prompt-at-a-time: `prompt()` rejects while another is in
 * flight, matching the one-shot delegation this package serves.
 */
export class OmpRpcClient {
  private buffer = ''
  private nextId = 1
  private closedReason: string | undefined
  private readonly pending = new Map<string, {
    resolve: (frame: JsonObject) => void
    reject: (error: Error) => void
  }>()

  private readyResolve: (() => void) | undefined
  private readyReject: ((error: Error) => void) | undefined
  private readonly readyPromise: Promise<void>

  /** Settled by the terminal `agent_end`; absent while no prompt is running. */
  private turnResolve: (() => void) | undefined
  private turnReject: ((error: Error) => void) | undefined

  /**
   * @param stdin - the child's stdin, which receives command frames.
   * @param stdout - the child's stdout, which carries `ready`, `response`, and event frames.
   */
  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
  ) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    // Rejected by `fail()` whether or not `whenReady()` has been called yet;
    // the handler only marks the rejection observed, and a later `whenReady()`
    // still receives it.
    this.readyPromise.catch(() => {})
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string) => {
      this.consume(chunk)
    })
    stdout.on('end', () => {
      this.fail('the omp RPC stream closed')
    })
    stdout.on('error', (error: Error) => {
      this.fail(`the omp RPC stream failed: ${error.message}`)
    })
  }

  /**
   * Resolve once the child has announced its protocol version.
   * @param signal - abort channel for the caller's startup window.
   * @returns fulfillment after the `ready` frame arrives.
   */
  async whenReady(signal: AbortSignal): Promise<void> {
    return this.race(this.readyPromise, signal)
  }

  /**
   * Run exactly one prompt and wait for the child's terminal turn.
   *
   * An `agent_end` carrying `willContinue: true` announces an automatic
   * continuation the child has already scheduled, so it is not a settle; the
   * wait continues to the next one.
   * @param message - the complete task text sent as one prompt frame.
   * @param signal - abort channel covering the whole turn.
   * @returns the child's final assistant text when it produced one.
   */
  async prompt(message: string, signal: AbortSignal): Promise<OmpTurnOutcome> {
    if (this.turnResolve !== undefined) {
      throw new OmpWireError('a prompt is already running on this connection')
    }
    const settled = new Promise<void>((resolve, reject) => {
      this.turnResolve = resolve
      this.turnReject = reject
    })
    // The turn is awaited only after the prompt command's own response, so a
    // wire failure in between rejects this with nothing attached; the handler
    // only marks that rejection observed and the `race` below still receives it.
    settled.catch(() => {})
    try {
      await this.request({ type: 'prompt', message }, signal)
      await this.race(settled, signal)
    } finally {
      this.turnResolve = undefined
      this.turnReject = undefined
    }
    const answer = await this.request({ type: 'get_last_assistant_text' }, signal)
    const data = asObject(answer.data)
    const text = data?.text
    return { text: typeof text === 'string' && text.length > 0 ? text : undefined }
  }

  /**
   * Stop serving and reject every waiter with the same reason.
   * @param reason - failure text carried to readiness, the turn, and every pending command.
   */
  close(reason: string): void {
    this.fail(reason)
  }

  private async request(command: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    if (this.closedReason !== undefined) {
      throw new OmpWireError(this.closedReason)
    }
    // Checked before the write, not only inside the race: a command written to
    // an already-cancelled request would still start work in the child.
    if (signal.aborted) throw new OmpWireError('the request was aborted')
    const id = String(this.nextId++)
    const settled = new Promise<JsonObject>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.stdin.write(`${JSON.stringify({ ...command, id })}\n`)
    try {
      return await this.race(settled, signal)
    } finally {
      this.pending.delete(id)
    }
  }

  private async race<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw new OmpWireError('the request was aborted')
    let abort!: (error: Error) => void
    const aborted = new Promise<never>((_resolve, reject) => { abort = reject })
    const onAbort = (): void => { abort(new OmpWireError('the request was aborted')) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await Promise.race([operation, aborted])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.trim().length > 0) this.dispatch(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private dispatch(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // A frame this client cannot parse is a protocol fault, not recoverable
      // noise: the child owns stdout framing and nothing else writes there.
      this.fail('the child emitted a frame that is not JSON')
      return
    }
    const frame = asObject(parsed)
    if (frame === undefined) {
      this.fail('the child emitted a frame that is not an object')
      return
    }
    switch (frame.type) {
      case 'ready': {
        this.readyResolve?.()
        this.readyResolve = undefined
        this.readyReject = undefined
        return
      }
      case 'rpc_chunk': {
        this.fail('the child negotiated protocol v2 chunking, which this client does not speak')
        return
      }
      case 'response': {
        const id = typeof frame.id === 'string' ? frame.id : undefined
        const waiter = id === undefined ? undefined : this.pending.get(id)
        if (waiter === undefined) return
        if (frame.success === true) waiter.resolve(frame)
        else waiter.reject(new OmpWireError(this.describeFailure(frame)))
        return
      }
      case 'agent_end': {
        if (frame.willContinue === true) return
        this.turnResolve?.()
        return
      }
      default:
        return
    }
  }

  private describeFailure(frame: JsonObject): string {
    const command = typeof frame.command === 'string' ? frame.command : 'command'
    const error = typeof frame.error === 'string' ? frame.error : undefined
    return error === undefined
      ? `the child rejected the ${command} command`
      : `the child rejected the ${command} command: ${error}`
  }

  private fail(reason: string): void {
    if (this.closedReason !== undefined) return
    this.closedReason = reason
    const error = new OmpWireError(reason)
    this.readyReject?.(error)
    this.readyResolve = undefined
    this.readyReject = undefined
    this.turnReject?.(error)
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
  }
}
