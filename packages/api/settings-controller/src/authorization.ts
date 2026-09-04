/**
 * Host owner of the `authorization` Remote namespace: the Consumer of
 * `ctx.authorization` that lets a browser configuration page run a sign-in.
 *
 * A subscription route — a Claude Pro/Max or ChatGPT Plus/Pro plan — cannot be
 * configured by typing a key, because the credential it needs is a grant a
 * person obtains by answering prompts. This namespace is the surface that
 * conversation happens on: one stream per attempt carries the flow's notices
 * and questions to the page that started it, and the page answers back over
 * the unary half.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/src/authorization.ts
 */

import { Context } from '@deepseek-ai/cordis'
import { credentialKeyId, parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import type {
  AuthorizationInteraction,
  AuthorizationNotice,
  AuthorizationPrompt,
  AuthorizationService,
} from '@deepseek-ai/dsh-authorization'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type {
  AuthorizationEntryView,
  AuthorizationFrame,
} from './types.ts'

const keySchema = z.string().min(1).max(256)
const startRequestSchema = z.object({ key: keySchema, method: z.string().min(1).max(64).optional() })
const answerRequestSchema = z.object({ promptId: z.string().min(1).max(128), value: z.string().max(8192) })
const cancelRequestSchema = z.object({ key: keySchema })

/** Parse the domain constraints that are more specific than generated TypeScript codecs. */
function parseRequest<T>(method: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new RemoteError('gateway/bad-request', `invalid payload for ${method}`, { issues: parsed.error.issues })
  }
  return parsed.data
}

/** One question waiting for the page that started the attempt to answer it. */
interface PendingPrompt {
  readonly resolve: (value: string) => void
  readonly reject: (error: Error) => void
}

/** Everything one in-flight attempt owns on the Host side. */
interface Attempt {
  readonly frames: AuthorizationFrame[]
  readonly waiters: (() => void)[]
  readonly prompts: Map<string, PendingPrompt>
  done: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `authorization` Remote namespace. */
    authorizationController: AuthorizationController
  }
}

/**
 * Host service backing the generated `ctx.remote.authorization` namespace.
 *
 * The wire identity of a flow is its credential key. Its id segment names what
 * the flow authorizes — for a provider route, the route id — which is how a
 * configuration page attaches a sign-in to the row it belongs to.
 */
export class AuthorizationController extends TypertRemoteService {
  private readonly attempts = new Map<string, Attempt>()
  private nextPrompt = 0

  /** @param ctx - Host context where the authorization registry may be mounted. */
  constructor(ctx: Context) {
    super(ctx, 'authorizationController', { namespace: 'authorization' })
  }

  /**
   * Every sign-in this deployment offers.
   * @returns one view per registered flow, with the methods it can run.
   * @throws RemoteError when the authorization registry is not mounted.
   */
  @Remote
  // eslint-disable-next-line @typescript-eslint/require-await -- async so a synchronous refusal reaches the caller as a rejection
  async list(): Promise<AuthorizationEntryView[]> {
    const registry = this.registry()
    return registry.list().map(entry => ({
      key: entry.key as string,
      subject: credentialKeyId(entry.key),
      label: entry.label,
      inFlight: entry.inFlight,
      methods: entry.methods.map(method => ({ id: method.id, label: method.label })),
    }))
  }

  /**
   * Run one sign-in, streaming what it needs from the person watching.
   *
   * The stream is the attempt: closing it withdraws the attempt, and a pending
   * question is rejected rather than left waiting for a page that has gone.
   * @param key - the credential key to authorize, from {@link list}.
   * @param method - which of the flow's methods to run; its first when omitted.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns notices and questions, then exactly one terminal frame.
   * @throws RemoteError when the request is invalid or the registry is not mounted.
   */
  @Remote({ mode: 'stream' })
  async *start(key: string, method: string | undefined, signal: AbortSignal): AsyncIterable<AuthorizationFrame> {
    const request = parseRequest('authorization.start', startRequestSchema, { key, method })
    const registry = this.registry()
    const credentialKey = this.parseKey(request.key)
    const attempt: Attempt = { frames: [], waiters: [], prompts: new Map(), done: false }
    this.attempts.set(request.key, attempt)
    const push = (frame: AuthorizationFrame): void => {
      attempt.frames.push(frame)
      for (const wake of attempt.waiters.splice(0)) wake()
    }
    const interaction = this.interaction(attempt, push)
    const run = registry.begin({
      key: credentialKey,
      ...request.method === undefined ? {} : { method: request.method },
      interaction,
      signal,
    })
    void run.then(
      (outcome) => { push({ kind: 'settled', outcome: outcome.status }) },
      (error: unknown) => {
        push({ kind: 'settled', outcome: 'failed', message: error instanceof Error ? error.message : String(error) })
      },
    ).finally(() => {
      attempt.done = true
      for (const wake of attempt.waiters.splice(0)) wake()
    })
    try {
      let cursor = 0
      while (true) {
        while (cursor < attempt.frames.length) {
          const frame = attempt.frames[cursor++]
          // The array only grows, so an index below its length always holds a frame.
          if (frame !== undefined) yield frame
          if (frame?.kind === 'settled') return
        }
        if (attempt.done) return
        await new Promise<void>((resolve) => { attempt.waiters.push(resolve) })
      }
    } finally {
      this.settleAttempt(request.key, attempt)
    }
  }

  /**
   * Answer the question one running sign-in asked.
   * @param promptId - identity carried by the `prompt` frame.
   * @param value - what the person typed or pasted.
   * @throws RemoteError when no running attempt is waiting on that question.
   */
  @Remote
  // eslint-disable-next-line @typescript-eslint/require-await -- async so a synchronous refusal reaches the caller as a rejection
  async answer(promptId: string, value: string): Promise<void> {
    const request = parseRequest('authorization.answer', answerRequestSchema, { promptId, value })
    for (const attempt of this.attempts.values()) {
      const pending = attempt.prompts.get(request.promptId)
      if (pending === undefined) continue
      attempt.prompts.delete(request.promptId)
      pending.resolve(request.value)
      return
    }
    throw new RemoteError(
      'authorization/not-waiting',
      `no sign-in is waiting on question "${request.promptId}"`,
      { promptId: request.promptId },
    )
  }

  /**
   * Withdraw one running sign-in.
   * @param key - the credential key whose attempt to withdraw.
   * @throws RemoteError when the request is invalid or the registry is not mounted.
   */
  @Remote
  // eslint-disable-next-line @typescript-eslint/require-await -- async so a synchronous refusal reaches the caller as a rejection
  async cancel(key: string): Promise<void> {
    const request = parseRequest('authorization.cancel', cancelRequestSchema, { key })
    this.registry().cancel(this.parseKey(request.key))
  }

  /** Bridge the seam's callbacks to this attempt's frames and pending answers. */
  private interaction(attempt: Attempt, push: (frame: AuthorizationFrame) => void): AuthorizationInteraction {
    return {
      notify: (notice: AuthorizationNotice) => {
        push({
          kind: 'notice',
          message: notice.message,
          ...notice.url === undefined ? {} : { url: notice.url },
          ...notice.code === undefined ? {} : { code: notice.code },
        })
      },
      prompt: (prompt: AuthorizationPrompt) => new Promise<string>((resolve, reject) => {
        const promptId = `prompt-${++this.nextPrompt}`
        attempt.prompts.set(promptId, { resolve, reject })
        // A prompt may be withdrawn on its own — an anthropic sign-in races a
        // pasted code against a browser callback — while the attempt continues.
        prompt.signal?.addEventListener('abort', () => {
          if (!attempt.prompts.delete(promptId)) return
          reject(new Error('the question was withdrawn'))
          push({ kind: 'prompt-withdrawn', promptId })
        }, { once: true })
        push({
          kind: 'prompt',
          promptId,
          promptKind: prompt.kind,
          message: prompt.message,
          ...prompt.kind === 'select'
            ? { options: prompt.options.map(option => ({
              id: option.id,
              label: option.label,
              ...option.description === undefined ? {} : { description: option.description },
            })) }
            : prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
        })
      }),
    }
  }

  /** Drop the attempt and reject anything still waiting for an answer. */
  private settleAttempt(key: string, attempt: Attempt): void {
    if (this.attempts.get(key) === attempt) this.attempts.delete(key)
    for (const pending of attempt.prompts.values()) {
      pending.reject(new Error('the sign-in surface closed before the question was answered'))
    }
    attempt.prompts.clear()
  }

  /** Brand one wire key or report it as a bad request. */
  private parseKey(key: string): CredentialKey {
    try {
      return parseCredentialKey(key)
    } catch (error) {
      throw new RemoteError(
        'authorization/invalid-key',
        `"${key}" is not a credential key`,
        { key, reason: error instanceof Error ? error.message : String(error) },
      )
    }
  }

  /** Resolve the optional registry or report how to supply it. */
  private registry(): AuthorizationService {
    const registry = this.ctx.get('authorization')
    if (registry === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'authorization service is absent: this deployment does not mount @deepseek-ai/dsh-authorization in its composition',
        {},
      )
    }
    return registry
  }
}

export default AuthorizationController
