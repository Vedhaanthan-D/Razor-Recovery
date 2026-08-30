import { useState, Fragment } from 'react'
import type { ReactNode } from 'react'
import {
  AlertTriangle, Tag, ShieldCheck, Scale, Workflow, RefreshCw,
  CheckCircle2, XCircle, Clock, Info,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Trace, Attempt } from '../pages/RecoveryJourneys'
import './JourneyTracker.css'

// Horizontal, shipment-tracking–style view of one payment's pipeline: filled circles connected by
// lines, with the recovery stage branching into a sub-row when the orchestrator escalated. Replaces
// the vertical <Step> list in TraceCard. Reuses the exact Trace/Attempt shapes from RecoveryJourneys.tsx and
// only the StatusPill colour vars from index.css — no new colours, no data-shape changes.

// Visual state of a node's circle. Maps 1:1 onto existing tokens (see JourneyTracker.css):
// origin=danger · step=accent(completed) · skip=ghost/dashed · ok/fail/pending=StatusPill colours.
type Tone = 'origin' | 'step' | 'skip' | 'ok' | 'fail' | 'pending' | 'none'

type Row = { label: string; value: ReactNode }

type NodeDesc = {
  key: string
  label: string
  icon: LucideIcon
  tone: Tone
  terminal?: boolean   // final outcome node → emphasised (filled/outline/pulsing)
  ghost?: boolean      // skipped or not-yet-run → dashed, faded, but still present (never a gap)
  badge?: boolean      // small completion check on a done agent step
  sub?: ReactNode      // sublabel under the title (chip / confidence / status)
  note?: string        // faint one-liner, e.g. "skipped — high confidence"
  title: string        // native hover tooltip (same affordance as App.tsx's cell-hint)
  rows: Row[]          // richer detail revealed on click
}

// Same money() the dashboard and Recovery Journeys page use (kept local — it isn't exported anywhere).
function money(n: number, currency: string) {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n)
  } catch {
    return `${currency} ${n.toFixed(0)}`
  }
}

const pct = (c: number | null) => (c == null ? null : `${Math.round(c * 100)}%`)

// Collect only the rows that have data — keeps detail panels tight without null clutter.
function rows(...entries: (Row | false | null | undefined)[]): Row[] {
  return entries.filter((e): e is Row => Boolean(e))
}

// The recovery chain's terminal state. 'lost' is a real payments.status the orchestrator sets when the
// escalation chain is exhausted (Backend/src/services/orchestratorService.js markLost) — so it's read
// from t.status, while success/pending come from the last attempt.
function terminalState(t: Trace): 'success' | 'lost' | 'pending' | 'none' {
  const a = t.attempts ?? []
  if (a.length === 0) return 'none'
  const last = a[a.length - 1]
  if (last.status === 'success') return 'success'
  if (t.status === 'lost') return 'lost'
  return 'pending' // failed-but-not-lost = escalation still in flight
}

const TERMINAL: Record<'success' | 'lost' | 'pending' | 'none', { tone: Tone; icon: LucideIcon }> = {
  success: { tone: 'ok', icon: CheckCircle2 },
  lost: { tone: 'fail', icon: XCircle },
  pending: { tone: 'pending', icon: Clock },
  none: { tone: 'none', icon: RefreshCw },
}

// StatusPill's mapping, reused so an attempt's status text is coloured identically to the pills.
function statusTone(s: string | null): Tone {
  if (s === 'success') return 'ok'
  if (s === 'failed' || s === 'lost') return 'fail'
  if (!s) return 'none'
  return 'pending'
}

// Label on the connector between two consecutive attempts — attempts[i].status==='failed' is why
// attempts[i+1] exists (the escalation), e.g. "auto_retry failed".
function escLabel(prev: Attempt): string {
  const why = prev.status === 'failed' ? 'failed' : prev.status || 'escalated'
  return `${prev.strategy || 'strategy'} ${why}`
}

// The four fixed pipeline stages that always precede recovery. Verified is always rendered — faded
// with a "skipped — high confidence" note when it didn't run — so the chain reads as continuous.
function fixedNodes(t: Trace): NodeDesc[] {
  const classified = Boolean(t.failure_reason)
  const verified = t.verified === true
  const advisorNote = t.advisor_note || 'Kept the classifier’s default strategy.'
  const strategy = t.recovery_strategy || t.suggested_strategy

  return [
    {
      key: 'failed',
      label: 'Failed',
      icon: AlertTriangle,
      tone: 'origin',
      title: `Payment failed — entered the recovery pipeline${t.created_at ? `\n${new Date(t.created_at).toLocaleString()}` : ''}`,
      rows: rows(
        { label: 'Payment', value: <span className="mono">{t.razorpay_payment_id}</span> },
        t.amount != null && { label: 'Amount', value: money(Number(t.amount), t.currency || 'INR') },
        !!t.created_at && { label: 'When', value: new Date(t.created_at!).toLocaleString() },
      ),
    },
    {
      key: 'classified',
      label: 'Classified',
      icon: Tag,
      tone: classified ? 'step' : 'none',
      badge: classified,
      ghost: !classified,
      note: classified ? undefined : 'not classified',
      sub: classified ? (
        <>
          <span className="jt-chip">{t.failure_reason}</span>
          {t.confidence != null && <span className="jt-pct">{pct(t.confidence)}</span>}
        </>
      ) : undefined,
      title: classified
        ? `${t.failure_reason}${t.confidence != null ? ` · ${pct(t.confidence)} confidence` : ''}${t.provider_used ? ` · ${t.provider_used}` : ''}${t.detail ? `\n${t.detail}` : ''}`
        : 'Not classified yet',
      rows: classified
        ? rows(
            { label: 'Reason', value: t.failure_reason },
            t.confidence != null && { label: 'Confidence', value: pct(t.confidence) },
            !!t.provider_used && { label: 'Provider', value: t.provider_used },
            !!t.detail && { label: 'Detail', value: t.detail },
          )
        : rows({ label: 'Status', value: 'Not classified' }),
    },
    {
      key: 'verified',
      label: 'Verified',
      icon: ShieldCheck,
      tone: verified ? 'step' : 'skip',
      badge: verified,
      ghost: !verified,
      note: verified ? undefined : 'skipped — high confidence',
      title: verified
        ? 'Low-confidence primary call — a second-opinion classifier overrode it, and its verdict was used.'
        : 'Verifier skipped — the primary classification was confident enough that no second opinion was needed.',
      rows: rows({
        label: 'Verifier',
        value: verified
          ? 'Overrode the low-confidence primary call; its verdict was used.'
          : 'Skipped — primary classification was high-confidence.',
      }),
    },
    {
      key: 'advised',
      label: 'Advised',
      icon: Scale,
      tone: 'step',
      badge: true,
      sub: strategy ? <span className="jt-chip">{strategy}</span> : undefined,
      title: advisorNote,
      rows: rows(
        { label: 'Advisor', value: advisorNote },
        !!strategy && { label: 'Strategy', value: strategy },
      ),
    },
  ]
}

// One recovery attempt as a node. The final attempt carries the terminal emphasis (green filled /
// red outline / amber pulsing); earlier ones show their own status softly.
function attemptNode(a: Attempt, i: number, isTerminal: boolean, t: Trace): NodeDesc {
  const term = TERMINAL[terminalState(t)]
  const tone: Tone = isTerminal ? term.tone : statusTone(a.status)
  const icon: LucideIcon = isTerminal
    ? term.icon
    : a.status === 'success'
    ? CheckCircle2
    : a.status === 'pending'
    ? Clock
    : XCircle
  const amt =
    a.recovered_amount != null && Number(a.recovered_amount) > 0
      ? money(Number(a.recovered_amount), t.currency || 'INR')
      : null
  const status = a.status || 'pending'

  return {
    key: `attempt-${i}`,
    label: a.strategy || `attempt ${i + 1}`,
    icon,
    tone,
    terminal: isTerminal,
    sub: <span className={`jt-status jt-status--${statusTone(a.status)}`}>{status}</span>,
    title: `${a.strategy || 'attempt'} · ${status}${amt ? ` · recovered ${amt}` : ''}${a.notes ? `\n${a.notes}` : ''}`,
    rows: rows(
      { label: 'Strategy', value: a.strategy || `attempt ${i + 1}` },
      { label: 'Status', value: status },
      !!amt && { label: 'Recovered', value: amt },
      !!a.attempted_at && { label: 'When', value: new Date(a.attempted_at!).toLocaleString() },
      !!a.notes && { label: 'Notes', value: a.notes },
    ),
  }
}

// The recovery summary that heads an escalation branch (>1 attempt). Tinted by the outcome; the
// literal terminal state lives on the last attempt node below it.
function junctionNode(t: Trace): NodeDesc {
  const state = terminalState(t)
  const outcome = state === 'success' ? 'Recovered' : state === 'lost' ? 'Lost' : 'In progress'
  return {
    key: 'recovery',
    label: 'Recovery',
    icon: Workflow,
    tone: TERMINAL[state].tone,
    sub: <span className="jt-count">{t.attempts.length} attempts</span>,
    title: `Escalation chain — ${t.attempts.length} attempts · ${outcome.toLowerCase()}`,
    rows: rows(
      { label: 'Attempts', value: String(t.attempts.length) },
      { label: 'Outcome', value: outcome },
      !!t.recovery_strategy && { label: 'Final strategy', value: t.recovery_strategy },
    ),
  }
}

// No recovery attempt yet — still shown (faded), never a gap.
function emptyRecovery(): NodeDesc {
  return {
    key: 'recovery',
    label: 'Recovery',
    icon: Clock,
    tone: 'none',
    ghost: true,
    note: 'no attempt yet',
    title: 'No recovery attempt yet.',
    rows: rows({ label: 'Recovery', value: 'No attempt yet.' }),
  }
}

export default function JourneyTracker({ t }: { t: Trace }) {
  const [open, setOpen] = useState<string | null>(null)
  const attempts = t.attempts ?? []
  const escalated = attempts.length > 1

  const fixed = fixedNodes(t)
  const recoveryMain: NodeDesc = escalated
    ? junctionNode(t)
    : attempts.length === 1
    ? attemptNode(attempts[0], 0, true, t)
    : emptyRecovery()
  const branch = escalated ? attempts.map((a, i) => attemptNode(a, i, i === attempts.length - 1, t)) : []

  // Flat lookup so the detail panel can resolve whichever node is open.
  const all: Record<string, NodeDesc> = {}
  for (const n of [...fixed, recoveryMain, ...branch]) all[n.key] = n

  const toggle = (key: string) => setOpen((cur) => (cur === key ? null : key))
  const nodeProps = (n: NodeDesc) => ({ desc: n, open: open === n.key, onToggle: () => toggle(n.key) })

  return (
    <div className="journey">
      <div className="jt-scroll">
        <div className="jt-track">
          {fixed.map((n, i) => (
            <Fragment key={n.key}>
              {i > 0 && <span className="jt-link" aria-hidden="true" />}
              <NodeView {...nodeProps(n)} />
            </Fragment>
          ))}

          <span className="jt-link" aria-hidden="true" />

          {escalated ? (
            <div className="jt-recovery">
              <NodeView {...nodeProps(recoveryMain)} />
              <div className="jt-branch">
                {branch.map((n, i) => (
                  <Fragment key={n.key}>
                    {i > 0 && (
                      <span className="jt-link jt-link--esc" aria-hidden="true">
                        <span className="jt-esc">{escLabel(attempts[i - 1])}</span>
                      </span>
                    )}
                    <NodeView {...nodeProps(n)} />
                  </Fragment>
                ))}
              </div>
            </div>
          ) : (
            <NodeView {...nodeProps(recoveryMain)} />
          )}
        </div>
      </div>

      {open && all[open] && <DetailPanel desc={all[open]} onClose={() => setOpen(null)} />}
    </div>
  )
}

function NodeView({ desc, open, onToggle }: { desc: NodeDesc; open: boolean; onToggle: () => void }) {
  const Icon = desc.icon
  const hasDetail = desc.rows.length > 0
  const cls = [
    'jt-node',
    `jt-node--${desc.tone}`,
    desc.terminal ? 'jt-node--terminal' : '',
    desc.ghost ? 'jt-node--ghost' : '',
    open ? 'is-open' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={cls}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-label={`${desc.label}${desc.note ? ` — ${desc.note}` : ''}`}
      title={desc.title}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onToggle()
        }
      }}
      style={{ cursor: hasDetail ? 'pointer' : 'default' }}
    >
      <span className="jt-dot">
        <Icon size={16} />
        {desc.badge && <span className="jt-badge" aria-hidden="true" />}
      </span>
      <span className="jt-node-body">
        <span className="jt-node-label">
          {desc.label}
          {hasDetail && <Info className="jt-info" size={11} aria-hidden="true" />}
        </span>
        {desc.sub && <span className="jt-node-sub">{desc.sub}</span>}
        {desc.note && <span className="jt-node-note">{desc.note}</span>}
      </span>
    </div>
  )
}

// Click-to-open panel — the richer counterpart to the hover title, mirroring how Recent Activity
// pairs a title tooltip with an Info affordance.
function DetailPanel({ desc, onClose }: { desc: NodeDesc; onClose: () => void }) {
  const Icon = desc.icon
  return (
    <div className="jt-detail" role="region" aria-label={`${desc.label} details`}>
      <div className="jt-detail-head">
        <span className={`jt-detail-icon jt-node--${desc.tone}`}>
          <span className="jt-dot">
            <Icon size={14} />
          </span>
        </span>
        <span className="jt-detail-title">{desc.label}</span>
        {desc.note && <span className="jt-detail-note">{desc.note}</span>}
        <button type="button" className="jt-detail-close" onClick={onClose} aria-label="Close details">
          ✕
        </button>
      </div>
      <dl className="jt-detail-rows">
        {desc.rows.map((r, i) => (
          <div className="jt-detail-row" key={i}>
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
