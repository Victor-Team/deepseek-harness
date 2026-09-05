import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { MemoryCredentials } from '../../../credentials/authorization/tests/memory.ts'
import AuthorizationController from '../src/authorization.ts'
import type { AuthorizationFrame } from '../src/types.ts'

const KEY = credentialKey('test', 'anthropic')

/** What one fixture attempt did, for a test to assert after it settles. */
interface FixtureFlow {
  /** What the flow does before committing; replaced per test. */
  run: (session: AuthorizationSession) => Promise<void>
  /** Resolves once the attempt's own promise settles, however it settled. */
  settled: Promise<void>
  /** The answer the flow received, when it asked for one. */
  answered?: string
  /** What a rejected question reported to the flow. */
  asked?: unknown
}

/** Mount the record store, the registry with one flow, and the controller. */
async function boot(): Promise<{ ctx: Context; flow: FixtureFlow }> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(AuthorizationService)
  let settle = (): void => {}
  const flow: FixtureFlow = {
    run: () => Promise.resolve(),
    settled: new Promise<void>((resolve) => { settle = resolve }),
  }
  ctx.authorization.registerFlow({
    key: KEY,
    label: 'Anthropic',
    methods: [{ id: 'oauth', label: 'Anthropic (Claude Pro/Max)' }],
    async run(session) {
      try {
        await flow.run(session)
        await ctx.credentials.modifyRecord(KEY, () =>
          Promise.resolve({ kind: 'grant', payload: { token: 'granted' } }))
      } finally {
        settle()
      }
    },
  })
  await ctx.plugin(AuthorizationController)
  return { ctx, flow }
}

/** Collect every frame the stream emits. */
async function drain(stream: AsyncIterable<AuthorizationFrame>): Promise<AuthorizationFrame[]> {
  const frames: AuthorizationFrame[] = []
  for await (const frame of stream) frames.push(frame)
  return frames
}

describe('the authorization Remote namespace a configuration surface calls', () => {
  it('publishes the authorization namespace from its own service key', async () => {
    const ctx = new Context()
    await ctx.plugin(AuthorizationController)

    const controller = ctx.authorizationController
    expect(controller.typertRemote.serviceKey).toBe('authorizationController')
    expect(controller.typertRemote.namespace).toBe('authorization')
    expect(remoteMethods(controller).map(entry => entry.method))
      .toEqual(['list', 'start', 'answer', 'cancel'])
  })

  it('reports the actionable configuration error while no authorization registry is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(AuthorizationController)

    const failure = await ctx.authorizationController.list()
      .then(() => undefined, (error: unknown) => error)

    expect(remoteErrorOf(failure)?.code).toBe('gateway/internal')
    expect(String(failure)).toContain('@deepseek-ai/dsh-authorization')
  })

  it('names each sign-in by its key and by what it authorizes', async () => {
    const { ctx } = await boot()

    expect(await ctx.authorizationController.list()).toEqual([{
      key: 'test/anthropic',
      subject: 'anthropic',
      label: 'Anthropic',
      inFlight: false,
      methods: [{ id: 'oauth', label: 'Anthropic (Claude Pro/Max)' }],
    }])
  })

  it('carries a sign-in conversation to the surface and the answer back', async () => {
    const { ctx, flow } = await boot()
    flow.run = async (session) => {
      session.notify({ message: 'Open this page to sign in', url: 'https://example.test/auth' })
      flow.answered = await session.prompt({ kind: 'text', message: 'Paste the code', placeholder: 'code' })
    }

    const frames: AuthorizationFrame[] = []
    for await (const frame of ctx.authorizationController.start('test/anthropic', undefined, new AbortController().signal)) {
      frames.push(frame)
      if (frame.kind === 'prompt') await ctx.authorizationController.answer(frame.promptId, 'pasted-code')
    }

    expect(frames[0]).toEqual({
      kind: 'notice', message: 'Open this page to sign in', url: 'https://example.test/auth',
    })
    expect(frames[1]).toMatchObject({
      kind: 'prompt', promptKind: 'text', message: 'Paste the code', placeholder: 'code',
    })
    expect(frames.at(-1)).toEqual({ kind: 'settled', outcome: 'authorized' })
    expect(flow.answered).toBe('pasted-code')
  })

  it('reports a failed sign-in as a settled frame rather than breaking the stream', async () => {
    const { ctx, flow } = await boot()
    flow.run = () => Promise.reject(new Error('the provider refused'))

    const frames = await drain(
      ctx.authorizationController.start('test/anthropic', undefined, new AbortController().signal),
    )

    expect(frames).toEqual([{ kind: 'settled', outcome: 'failed', message: 'the provider refused' }])
  })

  it('rejects a pending question when the surface closes instead of leaving the flow waiting', async () => {
    const { ctx, flow } = await boot()
    flow.run = async (session) => {
      flow.asked = await session.prompt({ kind: 'text', message: 'Paste the code' })
        .then(() => undefined, (error: unknown) => error)
    }

    for await (const frame of ctx.authorizationController.start('test/anthropic', undefined, new AbortController().signal)) {
      // Leaving the loop closes the stream with the question unanswered, which
      // is what a person closing the settings page does.
      if (frame.kind === 'prompt') break
    }
    await flow.settled

    expect(String(flow.asked)).toContain('closed before the question was answered')
  })

  it('refuses an answer no running sign-in is waiting for', async () => {
    const { ctx } = await boot()

    const failure = await ctx.authorizationController.answer('prompt-404', 'x')
      .then(() => undefined, (error: unknown) => error)

    expect(remoteErrorOf(failure)?.code).toBe('authorization/not-waiting')
  })

  it('refuses a key that is not a credential key', async () => {
    const { ctx } = await boot()

    const failure = await ctx.authorizationController.cancel('not a key')
      .then(() => undefined, (error: unknown) => error)

    expect(remoteErrorOf(failure)?.code).toBe('authorization/invalid-key')
  })
})
