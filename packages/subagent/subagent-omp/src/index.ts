/**
 * Profile-named omp one-shot subagent provider. Every accepted run spawns an
 * oh-my-pi child in the delegating Session's workspace, drives it over the omp
 * RPC protocol, and returns the child's final answer through the shared
 * subagent result contract.
 *
 * @module @deepseek-ai/dsh-subagent-omp
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  resolveChildCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import {
  DEFAULT_DISPOSE_EOF_GRACE_MS,
  DEFAULT_DISPOSE_GRACE_MS,
  startOmpRun,
  type OmpRunSpec,
} from './run.ts'

export const name = 'subagent-omp'
export const inject = ['subagents', 'subprocess']

const DEFAULT_PROVIDER_NAME = 'omp'
const DEFAULT_COMMAND = 'omp'

/** Deployment-owned command, model, environment, and process-release settings. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `omp`). */
  providerName?: string
  /** The omp executable to spawn; resolved through the host `PATH` unless absolute. */
  command?: string
  /** Arguments placed before this package's fixed RPC-mode flags. */
  args?: string[]
  /**
   * Working-directory override for the child process; a relative value resolves
   * against the harness launch directory at load. Omission uses the delegating
   * parent session's workspace.
   */
  cwd?: string
  /**
   * Model id passed to the child as `--model`. Omission leaves omp's own
   * selection — its configured role models and profile defaults — in force.
   */
  model?: string
  /** Explicit child environment layered over the credential-scrubbed parent environment. */
  env?: Record<string, string>
  /** Grace in milliseconds after stdin EOF before process-tree termination begins. */
  disposeEofGraceMs?: number
  /** Grace in milliseconds between the process-tree termination tiers. */
  disposeGraceMs?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  command: z.string().min(1).default(DEFAULT_COMMAND),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1),
  model: z.string().min(1),
  env: z.dict(z.string()).default({}),
  disposeEofGraceMs: z.number().default(DEFAULT_DISPOSE_EOF_GRACE_MS),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

type ResolvedConfig = Omit<Required<Config>, 'cwd' | 'model'> & Pick<Config, 'cwd' | 'model'>

class OmpProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  async start(request: ResolvedSubagentStartRequest) {
    const parentCwd = request.parent.session.header.cwd
    if (parentCwd === undefined) {
      throw new Error(
        'subagent-omp: no working directory for the child — delegate from a parent session that has one',
      )
    }
    const cwd = resolveChildCwd('subagent-omp', this.config.cwd, parentCwd)
    const spec: OmpRunSpec = {
      command: this.config.command,
      args: this.config.args,
      cwd,
      model: this.config.model,
      env: this.config.env,
      disposeEofGraceMs: this.config.disposeEofGraceMs,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-omp "${this.name}": child run failed (${stopReason}): %o`,
          error,
        )
      },
    }
    return startOmpRun(request, spec)
  }
}

/**
 * Register one Profile-named omp provider.
 * @param ctx - context carrying the shared subagent and subprocess services.
 * @param config - registry name, command, model, child environment, and disposal grace.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    providerName: config.providerName as string,
    command: config.command as string,
    args: config.args as string[],
    ...config.cwd === undefined ? {} : { cwd: config.cwd },
    ...config.model === undefined ? {} : { model: config.model },
    env: config.env as Record<string, string>,
    disposeEofGraceMs: config.disposeEofGraceMs as number,
    disposeGraceMs: config.disposeGraceMs as number,
  }
  for (const field of ['disposeEofGraceMs', 'disposeGraceMs'] as const) {
    assertPositiveFinite('subagent-omp', field, resolved[field])
    if (resolved[field] > MAX_TIMER_DELAY_MS) {
      throw new Error(`subagent-omp: ${field} must be no greater than ${MAX_TIMER_DELAY_MS}`)
    }
  }
  ctx.subagents.registerProvider(new OmpProvider(resolved.providerName, ctx, resolved))
}
