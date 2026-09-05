/**
 * Browser-safe failure vocabulary of the configuration surfaces this package
 * serves. The redacted views themselves live with their seam in
 * `@deepseek-ai/dsh-settings/types`, whose Cordis event declarations already
 * register that file for the Client compilation face.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * The provider refused a valid credential write, for example because a
     * read-only source shadows the reference. The details name only the
     * reference, never the value.
     */
    'credential/rejected': { readonly ref: string }
    /** The named key is not a credential key this deployment can authorize. */
    'authorization/invalid-key': { readonly key: string; readonly reason: string }
    /** No running sign-in is waiting on the answered question. */
    'authorization/not-waiting': { readonly promptId: string }
  }
}

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}

/** Result of opening or revealing one locally authored Agent preset directory. */
export type AgentPresetDirectoryOpenValue =
  | { readonly opened: true }
  | { readonly opened: false; readonly path: string }

/** One login method a sign-in offers, as a configuration page renders it. */
export interface AuthorizationMethodView {
  /** Method id passed back to start an attempt. */
  readonly id: string
  /** User-facing name, such as `Anthropic (Claude Pro/Max)`. */
  readonly label: string
}

/** One registered sign-in as a configuration page reads it. */
export interface AuthorizationEntryView {
  /** Opaque credential key identifying this sign-in on later calls. */
  readonly key: string
  /**
   * What the sign-in authorizes, in the vocabulary of the surface that shows
   * it: for a provider route, the route id, which is how a Models page
   * attaches a sign-in to the row it belongs to.
   */
  readonly subject: string
  /** User-facing name of what is being authorized. */
  readonly label: string
  /** Whether an attempt for this sign-in is already running. */
  readonly inFlight: boolean
  /** The methods this sign-in offers, most preferred first. */
  readonly methods: readonly AuthorizationMethodView[]
}

/** One choice offered by a `select` question. */
export interface AuthorizationOptionView {
  readonly id: string
  readonly label: string
  readonly description?: string
}

/**
 * One thing a running sign-in has to say. A `prompt` frame is answered with
 * `authorization.answer`; `prompt-withdrawn` retires a question the flow gave
 * up on while the attempt continues; exactly one `settled` frame ends the
 * stream.
 */
export type AuthorizationFrame =
  | { readonly kind: 'notice'; readonly message: string; readonly url?: string; readonly code?: string }
  | {
    readonly kind: 'prompt'
    readonly promptId: string
    readonly promptKind: 'text' | 'secret' | 'select'
    readonly message: string
    readonly placeholder?: string
    readonly options?: readonly AuthorizationOptionView[]
  }
  | { readonly kind: 'prompt-withdrawn'; readonly promptId: string }
  | {
    readonly kind: 'settled'
    readonly outcome: 'authorized' | 'cancelled' | 'failed'
    readonly message?: string
  }
