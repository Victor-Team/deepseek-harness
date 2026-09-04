/**
 * One provider card's sign-in area: the button that starts a subscription
 * sign-in, and the conversation it runs.
 *
 * A subscription plan's credential is a grant obtained by answering questions,
 * not a key someone types, so this area is the only path by which such a route
 * reaches the credential store. It renders nothing for a provider the Host
 * offers no sign-in for, which is every provider whose adapter family ships no
 * login.
 *
 * The attempt lives in this component: unmounting aborts it, which the Host
 * reads as the page closing and rejects the question still waiting rather than
 * leaving the flow suspended.
 *
 * @module dsh-client-ui-settings-models/client/SignInPanel
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AuthorizationEntryView, AuthorizationFrame } from '@deepseek-ai/dsh-api-remotes/client'
import type { en } from './locales.ts'
import type { ModelsOperations } from './operations.ts'
import styles from './ModelsSection.module.css'

/** Props of {@link SignInPanel}. */
export interface SignInPanelProps {
  /** The sign-in this provider row offers. */
  entry: AuthorizationEntryView
  /** Localizer for this area's own labels. */
  t: (key: keyof typeof en) => string
  /** Host operations the attempt runs through. */
  operations: ModelsOperations
  /** Whether the deployment refuses writes; holds the button. */
  readOnly: boolean
  /** Called once a sign-in commits, so the page can re-read what changed. */
  onAuthorized: () => void
}

/** The question this attempt is waiting on, if any. */
interface OpenPrompt {
  readonly promptId: string
  readonly message: string
  readonly secret: boolean
  readonly placeholder?: string
}

/** Substitute `{name}` placeholders in one copy template. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole)
}

/**
 * Render one provider's sign-in area.
 * @param props - the offered sign-in, the localizer, and the Host operations.
 * @returns the sign-in button, and the running attempt's conversation.
 */
export function SignInPanel(props: SignInPanelProps): ReactNode {
  const { entry, t, operations, readOnly, onAuthorized } = props
  const [running, setRunning] = useState(false)
  const [notices, setNotices] = useState<readonly { message: string; url?: string; code?: string }[]>([])
  const [prompt, setPrompt] = useState<OpenPrompt | undefined>(undefined)
  const [answer, setAnswer] = useState('')
  const [answering, setAnswering] = useState(false)
  const [outcome, setOutcome] = useState<string | undefined>(undefined)
  const abort = useRef<AbortController | undefined>(undefined)

  // Unmounting withdraws the attempt: the Host treats a closed stream as the
  // page going away and stops the flow rather than leaving it waiting.
  useEffect(() => () => { abort.current?.abort() }, [])

  const method = entry.methods[0]

  const start = useCallback(() => {
    if (method === undefined) return
    const controller = new AbortController()
    abort.current = controller
    setRunning(true)
    setNotices([])
    setPrompt(undefined)
    setOutcome(undefined)
    void (async () => {
      try {
        for await (const frame of operations.runSignIn(entry.key, method.id, controller.signal)) {
          apply(frame)
        }
      } catch (error: unknown) {
        setOutcome(fill(t('signInFailed'), { message: error instanceof Error ? error.message : String(error) }))
      } finally {
        setRunning(false)
        setPrompt(undefined)
      }
    })()

    function apply(frame: AuthorizationFrame): void {
      switch (frame.kind) {
        case 'notice':
          setNotices(current => [...current, {
            message: frame.message,
            ...frame.url === undefined ? {} : { url: frame.url },
            ...frame.code === undefined ? {} : { code: frame.code },
          }])
          return
        case 'prompt':
          setAnswer('')
          setPrompt({
            promptId: frame.promptId,
            message: frame.message,
            secret: frame.promptKind === 'secret',
            ...frame.placeholder === undefined ? {} : { placeholder: frame.placeholder },
          })
          return
        case 'prompt-withdrawn':
          setPrompt(current => current?.promptId === frame.promptId ? undefined : current)
          return
        case 'settled':
          setPrompt(undefined)
          if (frame.outcome === 'authorized') {
            setOutcome(t('signInAuthorized'))
            onAuthorized()
            return
          }
          setOutcome(frame.outcome === 'cancelled'
            ? t('signInCancelled')
            : fill(t('signInFailed'), { message: frame.message ?? '' }))
          return
        default:
          // A Host newer than this page may add frames; ignoring one keeps the
          // conversation running instead of ending it on an unknown kind.
          return
      }
    }
  }, [entry.key, method, operations, onAuthorized, t])

  const send = useCallback(() => {
    if (prompt === undefined) return
    setAnswering(true)
    void operations.answerSignIn(prompt.promptId, answer).then((refusal) => {
      setAnswering(false)
      if (refusal === undefined) {
        setPrompt(undefined)
        setAnswer('')
        return
      }
      setOutcome(fill(t('signInFailed'), { message: refusal }))
    })
  }, [answer, operations, prompt, t])

  if (method === undefined) return null

  return (
    <div className={styles['signInPanel']}>
      {running
        ? (
          <button
            type="button"
            className={styles['secondaryButton']}
            onClick={() => { abort.current?.abort() }}
          >
            {t('signInCancel')}
          </button>
        )
        : (
          <button
            type="button"
            className={styles['secondaryButton']}
            disabled={readOnly || entry.inFlight}
            onClick={start}
          >
            {fill(t('signInWith'), { method: method.label })}
          </button>
        )}
      {notices.map(notice => (
        <p key={notice.message} className={styles['signInNotice']}>
          {notice.message}
          {notice.url === undefined
            ? null
            : (
              <>
                {' '}
                <a href={notice.url} target="_blank" rel="noreferrer">{t('signInOpen')}</a>
              </>
            )}
          {notice.code === undefined ? null : ` ${fill(t('signInCode'), { code: notice.code })}`}
        </p>
      ))}
      {prompt === undefined
        ? null
        : (
          <div className={styles['field']}>
            <span className={styles['fieldLabel']}>{prompt.message}</span>
            <input
              className={styles['input']}
              type={prompt.secret ? 'password' : 'text'}
              value={answer}
              aria-label={prompt.message}
              placeholder={prompt.placeholder ?? ''}
              onChange={(event) => { setAnswer(event.target.value) }}
              onKeyDown={(event) => { if (event.key === 'Enter') send() }}
            />
            <button
              type="button"
              className={styles['secondaryButton']}
              disabled={answering || answer.length === 0}
              onClick={send}
            >
              {answering ? t('signInAnswering') : t('signInAnswer')}
            </button>
          </div>
        )}
      {outcome === undefined ? null : <p className={styles['signInNotice']}>{outcome}</p>}
    </div>
  )
}
