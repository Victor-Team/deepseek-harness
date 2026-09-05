import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { OmpRpcClient } from '../src/rpc.ts'

/**
 * Protocol-level tests for the omp RPC client. Each drives the client over a
 * pair of in-memory streams and scripts the child's side by hand, so the
 * framing, command correlation, and terminal-turn rules are exercised without
 * spawning omp.
 */

/** One scripted wire: the client's view plus helpers to read commands and push frames. */
function wire() {
  const toChild = new PassThrough()
  const toClient = new PassThrough()
  const client = new OmpRpcClient(toChild, toClient)
  const commands: Record<string, unknown>[] = []
  const waiters: { count: number; resolve: (frame: Record<string, unknown>) => void }[] = []
  let buffered = ''
  toChild.on('data', (chunk: Buffer) => {
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
    client,
    commands,
    push(frame: unknown): void {
      toClient.write(`${JSON.stringify(frame)}\n`)
    },
    pushRaw(line: string): void {
      toClient.write(`${line}\n`)
    },
    end(): void {
      toClient.end()
    },
    /** Wait until the child has observed `count` commands. */
    async settle(count: number): Promise<Record<string, unknown>> {
      if (commands.length >= count) return commands[count - 1]!
      return await new Promise<Record<string, unknown>>((resolve) => {
        waiters.push({ count, resolve })
      })
    },
  }
}

const ready = { type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] }
const signal = (): AbortSignal => new AbortController().signal

describe('omp RPC client', () => {
  it('resolves readiness on the ready frame', async () => {
    const w = wire()
    w.push(ready)
    await expect(w.client.whenReady(signal())).resolves.toBeUndefined()
  })

  it('ignores a continuation agent_end and settles on the terminal one', async () => {
    const w = wire()
    w.push(ready)
    await w.client.whenReady(signal())

    const running = w.client.prompt('task', signal())
    const prompt = await w.settle(1)
    expect(prompt).toMatchObject({ type: 'prompt', message: 'task' })

    w.push({ type: 'response', id: prompt.id, command: 'prompt', success: true })
    // An automatic continuation the child already scheduled: not a settle.
    w.push({ type: 'agent_end', willContinue: true, messages: [] })
    await new Promise(resolve => setImmediate(resolve))
    expect(w.commands).toHaveLength(1)

    w.push({ type: 'agent_end', messages: [] })
    const answer = await w.settle(2)
    expect(answer).toMatchObject({ type: 'get_last_assistant_text' })
    w.push({ type: 'response', id: answer.id, command: 'get_last_assistant_text', success: true, data: { text: 'final' } })

    await expect(running).resolves.toEqual({ text: 'final' })
  })

  it('reports no text when the child returns a null or blank answer', async () => {
    for (const text of [null, '']) {
      const w = wire()
      w.push(ready)
      await w.client.whenReady(signal())
      const running = w.client.prompt('task', signal())
      const prompt = await w.settle(1)
      w.push({ type: 'response', id: prompt.id, command: 'prompt', success: true })
      w.push({ type: 'agent_end', messages: [] })
      const answer = await w.settle(2)
      w.push({ type: 'response', id: answer.id, command: 'get_last_assistant_text', success: true, data: { text } })
      await expect(running).resolves.toEqual({ text: undefined })
    }
  })

  it('fails the wire on a protocol-v2 chunk frame instead of reassembling it', async () => {
    const w = wire()
    w.push(ready)
    await w.client.whenReady(signal())
    const running = w.client.prompt('task', signal())
    w.push({ type: 'rpc_chunk', chunkId: 'c1', index: 0, count: 2, byteLength: 4, data: 'ab' })
    await expect(running).rejects.toThrow(/protocol v2 chunking/)
  })

  it('rejects a command the child answers with success:false', async () => {
    const w = wire()
    w.push(ready)
    await w.client.whenReady(signal())
    const running = w.client.prompt('task', signal())
    const prompt = await w.settle(1)
    w.push({ type: 'response', id: prompt.id, command: 'prompt', success: false, error: 'no model' })
    await expect(running).rejects.toThrow(/rejected the prompt command: no model/)
  })

  it('describes a failed response with no error string', async () => {
    const w = wire()
    w.push(ready)
    await w.client.whenReady(signal())
    const running = w.client.prompt('task', signal())
    const prompt = await w.settle(1)
    w.push({ type: 'response', id: prompt.id, command: 'prompt', success: false })
    await expect(running).rejects.toThrow(/rejected the prompt command$/)
  })

  it('names an unlabelled failed response generically', async () => {
    const w = wire()
    w.push(ready)
    await w.client.whenReady(signal())
    const running = w.client.prompt('task', signal())
    const prompt = await w.settle(1)
    w.push({ type: 'response', id: prompt.id, success: false, error: 'boom' })
    await expect(running).rejects.toThrow(/rejected the command command: boom/)
  })

  it('rejects readiness on an already-aborted signal', async () => {
    const w = wire()
    const controller = new AbortController()
    controller.abort()
    await expect(w.client.whenReady(controller.signal)).rejects.toThrow(/aborted/)
  })

  it('skips a blank line between frames', async () => {
    const w = wire()
    w.pushRaw('')
    w.pushRaw('   ')
    w.push(ready)
    await expect(w.client.whenReady(signal())).resolves.toBeUndefined()
  })

  it('fails on a frame that is not JSON', async () => {
    const w = wire()
    w.pushRaw('{ not json')
    await expect(w.client.whenReady(signal())).rejects.toThrow(/not JSON/)
  })

  it('fails on a frame that is not an object', async () => {
    const w = wire()
    w.push(['array'])
    await expect(w.client.whenReady(signal())).rejects.toThrow(/not an object/)
  })

  it('fails every waiter when the stream closes', async () => {
    const w = wire()
    w.push(ready)
    await w.client.whenReady(signal())
    const running = w.client.prompt('task', signal())
    await w.settle(1)
    w.end()
    await expect(running).rejects.toThrow(/stream closed/)
  })

  it('refuses a second concurrent prompt', async () => {
    const w = wire()
    w.push(ready)
    await w.client.whenReady(signal())
    const running = w.client.prompt('one', signal())
    await w.settle(1)
    await expect(w.client.prompt('two', signal())).rejects.toThrow(/already running/)
    w.client.close('done')
    await expect(running).rejects.toThrow()
  })

  it('rejects a request made after the wire closed', async () => {
    const w = wire()
    w.push(ready)
    await w.client.whenReady(signal())
    w.client.close('closed by test')
    await expect(w.client.prompt('task', signal())).rejects.toThrow(/closed by test/)
  })

  it('rejects an already-aborted request without writing a command', async () => {
    const w = wire()
    w.push(ready)
    await w.client.whenReady(signal())
    const controller = new AbortController()
    controller.abort()
    await expect(w.client.prompt('task', controller.signal)).rejects.toThrow(/aborted/)
    expect(w.commands).toHaveLength(0)
  })

  it('rejects an in-flight request when its signal aborts', async () => {
    const w = wire()
    w.push(ready)
    await w.client.whenReady(signal())
    const controller = new AbortController()
    const running = w.client.prompt('task', controller.signal)
    await w.settle(1)
    controller.abort()
    await expect(running).rejects.toThrow(/aborted/)
  })

  it('ignores an uncorrelated response and every unhandled event frame', async () => {
    const w = wire()
    w.push(ready)
    await w.client.whenReady(signal())
    const running = w.client.prompt('task', signal())
    const prompt = await w.settle(1)
    w.push({ type: 'response', id: 'no-such-id', command: 'prompt', success: true })
    w.push({ type: 'response', command: 'prompt', success: true })
    w.push({ type: 'text_delta', text: 'partial' })
    w.push({ type: 'agent_start' })
    await new Promise(resolve => setImmediate(resolve))

    w.push({ type: 'response', id: prompt.id, command: 'prompt', success: true })
    w.push({ type: 'agent_end', messages: [] })
    const answer = await w.settle(2)
    w.push({ type: 'response', id: answer.id, command: 'get_last_assistant_text', success: true, data: {} })
    await expect(running).resolves.toEqual({ text: undefined })
  })

  it('fails every waiter when the stream errors', async () => {
    const toChild = new PassThrough()
    const toClient = new PassThrough()
    const client = new OmpRpcClient(toChild, toClient)
    const readiness = client.whenReady(signal())
    toClient.emit('error', new Error('pipe broke'))
    await expect(readiness).rejects.toThrow(/stream failed: pipe broke/)
  })

  it('closes only once', async () => {
    const w = wire()
    w.push(ready)
    await w.client.whenReady(signal())
    w.client.close('first')
    w.client.close('second')
    await expect(w.client.prompt('task', signal())).rejects.toThrow(/first/)
  })
})
