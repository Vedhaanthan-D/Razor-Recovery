import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Workflow, ChevronDown, CreditCard, AlertTriangle, Tag, Scale } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import JourneyTracker from '../components/JourneyTracker'
import { strategyLabel, providerLabel, humanizeReason } from '../App'

// One recovery attempt in a payment's escalation chain (from dashboard.js recent[].attempts).
// Exported so JourneyTracker can reuse the exact same shape (single source of truth).
export type Attempt = {
  strategy: string | null
  status: string | null
  recovered_amount: number | null
  notes: string | null
  attempted_at: string | null
}

// A payment's full pipeline trace — the fields GET /api/dashboard already returns per recent[] row.
export type Trace = {
  razorpay_payment_id: string
  amount: number | null
  currency: string | null
  method: string | null
  status: string | null
  created_at: string | null
  error_code: string | null        // raw Razorpay code, e.g. BAD_REQUEST_ERROR (returned by dashboard.js)
  error_description: string | null  // raw Razorpay human message (returned by dashboard.js)
  failure_reason: string | null
  detail: string | null
  confidence: number | null
  suggested_strategy: string | null
  provider_used: string | null
  verified: boolean | null
  advisor_note: string | null
  recovery_strategy: string | null
  recovery_status: string | null
  attempts: Attempt[]
}

function money(n: number, currency: string) {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n)
  } catch {
    return `${currency} ${n.toFixed(0)}`
  }
}

// The recovery chain's terminal outcome — same semantics as JourneyTracker.terminalState (success from
// the last attempt, 'lost' from t.status, else pending; none when nothing's been attempted yet). Kept
// local rather than shared because it also carries the label + colour tone used by the one-liner.
function outcome(t: Trace): { label: string; tone: 'ok' | 'fail' | 'pending' | 'none' } {
  const a = t.attempts ?? []
  if (a.length === 0) return { label: 'Awaiting recovery', tone: 'none' }
  const last = a[a.length - 1]
  if (last.status === 'success') return { label: 'Recovered', tone: 'ok' }
  if (t.status === 'lost') return { label: 'Lost', tone: 'fail' }
  return { label: 'Pending', tone: 'pending' }
}

export default function RecoveryJourneys() {
  const [traces, setTraces] = useState<Trace[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    fetch('/api/dashboard')
      .then((r) => r.json().then((b) => { if (!r.ok) throw new Error(b.error || 'fetch failed'); return b }))
      .then((b) => { if (alive) { setTraces((b.recent || []).slice(0, 15)); setState('ready') } })
      .catch((e) => { if (alive) { setErr(e.message); setState('error') } })
    return () => { alive = false }
  }, [])

  return (
    <div className="dash">
      <header className="page-head">
        <h1><Workflow size={26} /> Recovery Journeys</h1>
        <p className="muted">Each of the last ~15 failed payments as a one-line summary — click any row to expand its full trace: classification, verification, strategy advice, and the recovery attempts that followed.</p>
      </header>

      {state === 'loading' && (
        <div className="traces" aria-busy="true" aria-live="polite">
          <span className="sr-only">Loading recovery journeys</span>
          {[0, 1, 2, 3, 4].map((i) => (
            <section className="trace rj-item" key={i}>
              <div className="rj-summary rj-summary--skel">
                <div className="skel skel-line" style={{ width: `${66 - i * 7}%`, maxWidth: 540 }} />
                <span className="skel rj-skel-chevron" aria-hidden="true" />
              </div>
            </section>
          ))}
        </div>
      )}
      {state === 'error' && <p className="err">Failed to load: {err}</p>}
      {state === 'ready' && traces.length === 0 && (
        <p className="muted zero">No payments yet. Trigger one from the Checkout page and it will appear here.</p>
      )}

      <div className="traces">
        {traces.map((t) => <TraceCard key={t.razorpay_payment_id} t={t} />)}
      </div>
    </div>
  )
}

// Accordion row: a crisp one-line summary (always visible) that expands — with a smooth height
// animation — to the full JourneyTracker plus a payment detail panel. Collapsed by default so the
// list stays scannable; full detail is one click away.
function TraceCard({ t }: { t: Trace }) {
  const [open, setOpen] = useState(false)
  const panelId = `rj-panel-${t.razorpay_payment_id}`

  return (
    <section className={`trace rj-item${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="rj-summary"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="rj-line"><SummaryLine t={t} /></span>
        <span className="rj-meta">
          <span className="muted small rj-when">{t.created_at ? new Date(t.created_at).toLocaleString() : ''}</span>
          <ChevronDown className="rj-chevron" size={18} aria-hidden="true" />
        </span>
      </button>

      <div className="rj-collapse" id={panelId}>
        <div className="rj-collapse-inner" role="region" aria-label="Full payment trace" inert={!open}>
          <div className="rj-expanded">
            <div className="trace-head rj-sub-head">
              <span className="mono trace-id">{t.razorpay_payment_id}</span>
              <span className="trace-amt">{t.amount != null ? money(Number(t.amount), t.currency || 'INR') : '—'}</span>
              <span className="muted small">{t.created_at ? new Date(t.created_at).toLocaleString() : ''}</span>
            </div>

            {/* Full recovery chain — the shipment-tracking pipeline (nodes stay individually clickable). */}
            <JourneyTracker t={t} />

            <PaymentDetail t={t} />
          </div>
        </div>
      </div>
    </section>
  )
}

// The plain-English one-liner, e.g. "₹223 payment via card failed (bank decline) → AI suggested
// alt_method → Pending". Every clause is guarded: no method → drop "via …" (never fabricated); no
// classification → "not yet classified"; no strategy → drop that arrow. Built only from Trace fields.
function SummaryLine({ t }: { t: Trace }) {
  const amtText = t.amount != null ? `${money(Number(t.amount), t.currency || 'INR')} payment` : 'Payment'
  const strategy = t.recovery_strategy || t.suggested_strategy
  const oc = outcome(t)

  return (
    <span className="rj-sentence">
      <span className="rj-amt">{amtText}</span>
      {t.method && <span className="rj-via"> via {t.method}</span>}
      {' failed'}
      {t.failure_reason
        ? <span className="rj-reason"> ({humanizeReason(t.failure_reason)})</span>
        : <span className="rj-reason"> — not yet classified</span>}
      {strategy && (
        <>
          <span className="rj-arrow"> → </span>AI suggested <code className="rj-strat">{strategy}</code>
        </>
      )}
      <span className="rj-arrow"> → </span>
      <span className={`rj-outcome rj-outcome--${oc.tone}`}>{oc.label}</span>
    </span>
  )
}

// The detail panel shown when a row is expanded: payment facts, the raw-vs-AI failure story, which
// classifier/provider ran (+ confidence + verifier action), and the advisor's reasoning.
function PaymentDetail({ t }: { t: Trace }) {
  const strategy = t.recovery_strategy || t.suggested_strategy
  const conf = t.confidence != null ? `${Math.round(t.confidence * 100)}%` : null

  return (
    <div className="rj-detail">
      <DetailCard icon={CreditCard} title="Payment initiated">
        <Row label="Amount" value={t.amount != null ? money(Number(t.amount), t.currency || 'INR') : '—'} />
        <Row label="Currency" value={t.currency || '—'} />
        <Row
          label="Method"
          value={t.method
            ? <span className="rj-chip">{t.method}</span>
            : <span className="rj-gap">not captured — payment predates method tracking</span>}
        />
      </DetailCard>

      <DetailCard icon={AlertTriangle} title="Why it failed" danger>
        <Row label="Error code" value={t.error_code ? <code>{t.error_code}</code> : '—'} />
        <Row label="Razorpay" value={t.error_description || '—'} />
        <Row
          label="AI reason"
          value={t.failure_reason
            ? <span className="rj-chip">{humanizeReason(t.failure_reason)}</span>
            : <span className="rj-gap">not classified</span>}
        />
        <Row label="AI detail" value={t.detail || '—'} />
      </DetailCard>

      <DetailCard icon={Tag} title="Classification">
        <Row label="Provider" value={providerLabel(t.provider_used)} />
        <Row label="Confidence" value={conf ?? '—'} />
        <Row
          label="Verifier"
          value={t.verified
            ? 'Overrode the low-confidence primary call — its verdict was used.'
            : 'Not needed — the primary classification was confident enough.'}
        />
      </DetailCard>

      <DetailCard icon={Scale} title="Strategy advice">
        <Row label="Strategy" value={strategy ? <span className="rj-chip">{strategyLabel(strategy)}</span> : '—'} />
        <Row label="Advisor" value={t.advisor_note || 'Kept the classifier’s default strategy.'} />
      </DetailCard>
    </div>
  )
}

function DetailCard({ icon: Icon, title, danger, children }: { icon: LucideIcon; title: string; danger?: boolean; children: ReactNode }) {
  return (
    <div className="rj-card">
      <div className={`rj-card-head${danger ? ' danger' : ''}`}><Icon size={13} aria-hidden="true" /> {title}</div>
      <dl className="rj-rows">{children}</dl>
    </div>
  )
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rj-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}
