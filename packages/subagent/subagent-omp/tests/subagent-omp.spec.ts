import { describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import * as omp from '../src/index.ts'
import {
  DEFAULT_DISPOSE_GRACE_MS,
  disposeOmpChild,
  ompArgv,
  startOmpRun,
  textTask,
  type OmpRunSpec,
} from '../src/run.ts'

/**
 * Backend tests for the omp subagent provider. The run lifecycle is driven over
 * a scripted in-memory child, so spawning, the handshake, publication, the
 * result, and the teardown ladder are exercised without omp on the host.
 */

/** A parent Agent stub; the backend reads only the session header's cwd. */
const fakeParent = { id: 'parent', session: { header: { cwd: process.cwd() } } } as unknown as Agent

function request(text = 'task', signal = new AbortController().signal) {
  return { prompt: [{ type: 'text' as const, text }], parent: fakeParent, signal }
}

interface FakeChild {
  handle: SubprocessHandle
  stdout: PassThrough
  commands: Record<string, unknown>[]
  settle: (outcome?: SubprocessOutcome) => void
  terminate: ReturnType<typeof vi.fn>
  /** Wait until the child has observed `count` commands, then return the last. */
  awaitCommand: (count: number) => Promise<Record<string, unknown>>
}

function fakeChild(options: { pid?: number; exitOnTerminate?: boolean; spawnFailure?: string } = {}): FakeChild {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let exited = false
  let resolveDone!: (outcome: SubprocessOutcome) => void
  let rejectDone!: (error: Error) => void
  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  if (options.spawnFailure !== undefined) {
    exited = true
    rejectDone(new Error(options.spawnFailure))
    done.catch(() => {})
  }
  const settle = (outcome: SubprocessOutcome = { exitCode: 0, signal: null }): void => {
    if (exited) return
    exited = true
    resolveDone(outcome)
  }
  const terminate = vi.fn<SubprocessHandle['terminate']>(() => {
    if (options.exitOnTerminate !== false) settle()
  })
  const waitForExit = vi.fn<SubprocessHandle['waitForExit']>(async (signal?: AbortSignal) => {
    if (exited) return true
    if (signal === undefined) {
      await done
      return true
    }
    return await new Promise<boolean>((resolve) => {
      const onAbort = (): void => { resolve(false) }
      signal.addEventListener('abort', onAbort, { once: true })
      void done.then(() => {
        signal.removeEventListener('abort', onAbort)
        resolve(true)
      })
    })
  })
  const commands: Record<string, unknown>[] = []
  const waiters: { count: number; resolve: (frame: Record<string, unknown>) => void }[] = []
  let buffered = ''
  stdin.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8')
    let newline = buffered.indexOf('\n')
    while (newline >= 0) {
      commands.push(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>)
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf('\n')
    }
    // Settled by arrival rather than by polling: under coverage instrumentation
    // a fixed number of microtask turns is not a reliable wait.
    for (let index = waiters.length - 1; index >= 0; index--) {
      const waiter = waiters[index]!
      if (commands.length >= waiter.count) {
        waiters.splice(index, 1)
        waiter.resolve(commands[waiter.count - 1]!)
      }
    }
  })
  return {
    handle: {
      pid: options.pid ?? 4321,
      stdin,
      stdout,
      stderr: undefined,
      collected: {},
      done,
      terminate,
      waitForExit,
    },
    stdout,
    commands,
    settle,
    terminate,
    async awaitCommand(count: number) {
      if (commands.length >= count) return commands[count - 1]!
      return await new Promise<Record<string, unknown>>((resolve) => {
        waiters.push({ count, resolve })
      })
    },
  }
}

function runSpec(child: FakeChild, overrides: Partial<OmpRunSpec> = {}): OmpRunSpec {
  return {
    command: 'omp',
    args: [],
    cwd: process.cwd(),
    model: undefined,
    env: {},
    // Short graces keep teardown inside the test timeout; `run.ts` owns the
    // shipped defaults, and the registration tests assert they reach the spawn.
    disposeEofGraceMs: 10,
    disposeGraceMs: 10,
    spawn: () => child.handle,
    onError: () => {},
    ...overrides,
  }
}

const ready = { type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] }

/** Push the frames that carry one prompt from publication to its final answer. */
async function completeTurn(child: FakeChild, text: string | null): Promise<void> {
  const prompt = await child.awaitCommand(1)
  child.stdout.write(`${JSON.stringify({ type: 'response', id: prompt.id, command: 'prompt', success: true })}\n`)
  child.stdout.write(`${JSON.stringify({ type: 'agent_end', messages: [] })}\n`)
  const answer = await child.awaitCommand(2)
  child.stdout.write(`${JSON.stringify({
    type: 'response',
    id: answer.id,
    command: 'get_last_assistant_text',
    success: true,
    data: { text },
  })}\n`)
}

describe('omp task text', () => {
  it('joins text blocks and rejects empty or non-text tasks', () => {
    expect(textTask([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab')
    expect(() => textTask([])).toThrow('only text blocks')
    expect(() => textTask([{ type: 'reasoning', text: 'hidden' }])).toThrow('only text blocks')
    expect(() => textTask([{ type: 'text', text: ' \n ' }])).toThrow('must not be empty')
  })
})

describe('omp argv', () => {
  it('appends the fixed RPC flags after configured arguments and adds a selected model', () => {
    const child = fakeChild()
    expect(ompArgv(runSpec(child, { args: ['--profile', 'work'] })))
      .toEqual(['omp', '--profile', 'work', '--mode', 'rpc', '--no-session'])
    expect(ompArgv(runSpec(child, { model: 'anthropic/claude-opus-5' })))
      .toEqual(['omp', '--mode', 'rpc', '--no-session', '--model', 'anthropic/claude-opus-5'])
    expect(ompArgv(runSpec(child, { args: ['--profile', 'work'], model: 'ollama/qwen3.5:9b' })))
      .toEqual(['omp', '--profile', 'work', '--mode', 'rpc', '--no-session', '--model', 'ollama/qwen3.5:9b'])
  })
})

describe('omp child disposal', () => {
  it('observes the outcome of a spawn-level failure without terminating', async () => {
    const child = fakeChild({ pid: -1 })
    child.settle()
    await expect(disposeOmpChild(child.handle, 10)).resolves.toBeUndefined()
    expect(child.terminate).not.toHaveBeenCalled()
  })

  it('swallows the rejection a failed spawn leaves on the outcome', async () => {
    const child = fakeChild({ pid: -1, spawnFailure: 'ENOENT: omp' })
    await expect(disposeOmpChild(child.handle, 10)).resolves.toBeUndefined()
    expect(child.terminate).not.toHaveBeenCalled()
  })

  it('returns after cooperative exit without escalating', async () => {
    const child = fakeChild()
    // Settled only after the wait is armed, so the timed grace path runs rather
    // than the already-exited shortcut the spawn-failure test covers.
    const disposed = disposeOmpChild(child.handle, MAX_TIMER_DELAY_MS)
    child.settle()
    await disposed
    expect(child.terminate).not.toHaveBeenCalled()
  })

  it('escalates to termination when the grace elapses', async () => {
    const child = fakeChild()
    await disposeOmpChild(child.handle, 1)
    expect(child.terminate).toHaveBeenCalledOnce()
  })
})

describe('omp run lifecycle', () => {
  it('publishes after the ready frame and returns the final answer', async () => {
    const child = fakeChild()
    let spawned: SubprocessSpawnSpec | undefined
    const started = startOmpRun(request(), runSpec(child, {
      spawn: (spec) => {
        spawned = spec
        return child.handle
      },
    }))
    child.stdout.write(`${JSON.stringify(ready)}\n`)
    const run = await started
    expect(spawned?.argv).toEqual(['omp', '--mode', 'rpc', '--no-session'])
    expect(run.localAgent).toBeUndefined()
    expect(run.id).toMatch(/[0-9a-f-]{36}/)

    await completeTurn(child, 'the answer')
    await expect(run.result).resolves.toEqual({
      stopReason: 'completed',
      output: [{ type: 'text', text: 'the answer' }],
    })
    await run.dispose()
  })

  it('settles as an error when the child produces no final answer', async () => {
    const child = fakeChild()
    const errors: string[] = []
    const started = startOmpRun(request(), runSpec(child, {
      onError: (error, stopReason) => { errors.push(`${stopReason}:${error.message}`) },
    }))
    child.stdout.write(`${JSON.stringify(ready)}\n`)
    const run = await started
    await completeTurn(child, null)
    await expect(run.result).resolves.toMatchObject({ stopReason: 'error' })
    expect(errors[0]).toMatch(/without a final answer/)
    await run.dispose()
  })

  it('rejects a task that is not text before spawning', async () => {
    const child = fakeChild()
    const spawn = vi.fn(() => child.handle)
    await expect(startOmpRun(
      { ...request(), prompt: [{ type: 'reasoning' as const, text: 'x' }] },
      runSpec(child, { spawn }),
    )).rejects.toThrow('only text blocks')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects an already-aborted request before spawning', async () => {
    const child = fakeChild()
    const controller = new AbortController()
    controller.abort()
    const spawn = vi.fn(() => child.handle)
    await expect(startOmpRun(request('task', controller.signal), runSpec(child, { spawn })))
      .rejects.toThrow('aborted before the child was spawned')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('tears the child down and rejects when it dies before the ready frame', async () => {
    const child = fakeChild()
    const started = startOmpRun(request(), runSpec(child))
    child.stdout.end()
    await expect(started).rejects.toThrow(/stream closed/)
    expect(child.terminate).toHaveBeenCalled()
  })

  it('rejects when the spawned child exposes no stdio', async () => {
    const child = fakeChild()
    const bare = { ...child.handle, stdin: undefined, stdout: undefined } as unknown as SubprocessHandle
    await expect(startOmpRun(request(), runSpec(child, { spawn: () => bare })))
      .rejects.toThrow('no stdio pipes')
  })

  it('settles cancellation as aborted and disposes once', async () => {
    const child = fakeChild()
    const controller = new AbortController()
    const started = startOmpRun(request('task', controller.signal), runSpec(child))
    child.stdout.write(`${JSON.stringify(ready)}\n`)
    const run = await started
    await child.awaitCommand(1)
    controller.abort()
    await expect(run.result).resolves.toMatchObject({ stopReason: 'aborted' })
    await run.dispose()
    await run.dispose()
  })
})

describe('omp provider registration', () => {
  it('registers the default descriptor and unregisters on HMR', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const fiber = await ctx.plugin(omp, {})
    expect(ctx.subagents.getProvider('omp')).toMatchObject({
      name: 'omp',
      capabilities: {
        agentOptions: false,
        outputSchema: false,
        depthLimit: false,
        toolFilter: false,
        persona: false,
      },
      inheritsParentContext: false,
    })
    expect(ctx.subagents.list()).toEqual(['omp'])
    await fiber.dispose()
    expect(ctx.subagents.list()).toEqual([])
  })

  it('accepts an explicit provider name, command, cwd, and model', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(omp, {
      providerName: 'omp-fast',
      command: '/opt/omp',
      cwd: '/srv/work',
      model: 'ollama/qwen3.5:9b',
    })
    expect(ctx.subagents.list()).toEqual(['omp-fast'])
    const provider = ctx.subagents.getProvider('omp-fast')!
    const child = fakeChild()
    let spawned: SubprocessSpawnSpec | undefined
    ctx.subprocess.spawn = (spec: SubprocessSpawnSpec) => {
      spawned = spec
      return child.handle
    }
    const started = provider.start({ ...request(), descriptor: undefined } as never)
    child.stdout.write(`${JSON.stringify(ready)}\n`)
    const run = await started
    expect(spawned?.argv).toEqual(['/opt/omp', '--mode', 'rpc', '--no-session', '--model', 'ollama/qwen3.5:9b'])
    expect(spawned?.cwd).toBe('/srv/work')
    child.settle()
    await run.dispose()
  })

  it('rejects a non-positive or oversized disposal grace', async () => {
    for (const field of ['disposeEofGraceMs', 'disposeGraceMs'] as const) {
      for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const ctx = new Context()
        await ctx.plugin(SubagentRuntime)
        await ctx.plugin(LocalSubprocessRuntime)
        await expect(ctx.plugin(omp, { [field]: value })).rejects.toThrow(/positive finite/)
      }
      const ctx = new Context()
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(LocalSubprocessRuntime)
      await expect(ctx.plugin(omp, { [field]: MAX_TIMER_DELAY_MS + 1 }))
        .rejects.toThrow(/no greater than/)
    }
  })

  it('starts a child through the registered provider using the parent workspace', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(omp, {})
    const provider = ctx.subagents.getProvider('omp')!
    const child = fakeChild()
    let spawned: SubprocessSpawnSpec | undefined
    ctx.subprocess.spawn = (spec: SubprocessSpawnSpec) => {
      spawned = spec
      return child.handle
    }
    const started = provider.start({ ...request(), descriptor: undefined } as never)
    child.stdout.write(`${JSON.stringify(ready)}\n`)
    const run = await started
    await completeTurn(child, 'ok')
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    expect(spawned?.cwd).toBe(process.cwd())
    expect(spawned?.graceMs).toBe(DEFAULT_DISPOSE_GRACE_MS)
    // Exit as omp does on stdin EOF: disposal here runs on the shipped default
    // grace, which outlasts the test timeout if the child never leaves.
    child.settle()
    await run.dispose()
  })

  it('warns through the context logger when a child run fails', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(omp, {})
    const provider = ctx.subagents.getProvider('omp')!
    const child = fakeChild()
    ctx.subprocess.spawn = () => child.handle
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const started = provider.start({ ...request(), descriptor: undefined } as never)
    child.stdout.write(`${JSON.stringify(ready)}\n`)
    const run = await started
    await completeTurn(child, null)
    await expect(run.result).resolves.toMatchObject({ stopReason: 'error' })
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toMatch(/child run failed \(error\)/)
    child.settle()
    await run.dispose()
  })

  it('refuses a parent session with no workspace', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(omp, {})
    const provider = ctx.subagents.getProvider('omp')!
    const parentless = { id: 'p', session: { header: {} } } as unknown as Agent
    await expect(provider.start({ ...request(), parent: parentless } as never))
      .rejects.toThrow('no working directory')
  })
})
