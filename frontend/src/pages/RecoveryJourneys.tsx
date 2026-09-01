import { useEffect, useState, useMemo } from 'react'
import type { ReactNode } from 'react'
import { Workflow, ChevronDown, CreditCard, AlertTriangle, Tag, Scale, Search, X, RefreshCw } from 'lucide-react'
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

// A payment's full pipeline trace — the fields GET /api/dashboard/journeys returns.
export type Trace = {
  razorpay_payment_id: string
  amount: number | null
  currency: string | null
  method: string | null
  status: string | null
  created_at: string | null
  error_code: string | null        // raw Razorpay code, e.g. BAD_REQUEST_ERROR
  error_description: string | null  // raw Razorpay human message
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

const KNOWN_REASONS = [
  'insufficient_funds',
  'bank_decline',
  'card_expired',
  'card_invalid',
  'network_timeout',
  'domestic_only_restriction',
  'currency_mismatch',
  'authentication_failed',
  'limit_exceeded',
  'other',
]

function money(n: number, currency: string) {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n)
  } catch {
    return `${currency} ${n.toFixed(0)}`
  }
}

// The recovery chain's terminal outcome — same semantics as JourneyTracker.terminalState.
function outcome(t: Trace): { label: string; tone: 'ok' | 'fail' | 'pending' | 'none' } {
  const a = t.attempts ?? []
  if (a.length === 0) return { label: 'Awaiting recovery', tone: 'none' }
  const last = a[a.length - 1]
  if (last.status === 'success') return { label: 'Recovered', tone: 'ok' }
  if (t.status === 'lost') return { label: 'Lost', tone: 'fail' }
  return { label: 'Pending', tone: 'pending' }
}

export default function RecoveryJourneys() {
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [reason, setReason] = useState('all')
  const [strategy, setStrategy] = useState('all')
  const [limit, setLimit] = useState(20)

  const [traces, setTraces] = useState<Trace[]>([])
  const [total, setTotal] = useState(0)
  const [fetchedReasons, setFetchedReasons] = useState<string[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [isFetchingMore, setIsFetchingMore] = useState(false)
  const [err, setErr] = useState('')

  // Debounce search input by 300ms
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search)
    }, 300)
    return () => clearTimeout(timer)
  }, [search])

  const handleStatusChange = (val: string) => { setStatus(val); setLimit(20) }
  const handleReasonChange = (val: string) => { setReason(val); setLimit(20) }
  const handleStrategyChange = (val: string) => { setStrategy(val); setLimit(20) }

  const clearFilters = () => {
    setSearch('')
    setDebouncedSearch('')
    setStatus('all')
    setReason('all')
    setStrategy('all')
    setLimit(20)
  }

  const hasActiveFilters = search !== '' || status !== 'all' || reason !== 'all' || strategy !== 'all'

  const allReasonsList = useMemo(() => {
    const set = new Set([...KNOWN_REASONS, ...fetchedReasons])
    return Array.from(set).sort()
  }, [fetchedReasons])

  useEffect(() => {
    let alive = true
    if (traces.length > 0 && limit > 20) {
      setIsFetchingMore(true)
    } else {
      setState('loading')
    }

    const params = new URLSearchParams()
    if (debouncedSearch) params.set('search', debouncedSearch)
    if (status !== 'all') params.set('status', status)
    if (reason !== 'all') params.set('reason', reason)
    if (strategy !== 'all') params.set('strategy', strategy)
    params.set('limit', String(limit))
    params.set('offset', '0')

    fetch(`/api/dashboard/journeys?${params.toString()}`)
      .then((r) => r.json().then((b) => { if (!r.ok) throw new Error(b.error || 'fetch failed'); return b }))
      .then((b) => {
        if (alive) {
          const items = b.items || b.traces || []
          setTraces(items)
          setTotal(b.total ?? items.length)
          if (b.reasons) setFetchedReasons(b.reasons)
          setState('ready')
          setIsFetchingMore(false)
        }
      })
      .catch((e) => {
        if (alive) {
          setErr(e.message)
          setState('error')
          setIsFetchingMore(false)
        }
      })

    return () => { alive = false }
  }, [debouncedSearch, status, reason, strategy, limit])

  return (
    <div className="dash">
      <header className="page-head">
        <h1><Workflow size={26} /> Recovery Journeys</h1>
        <p className="muted">
          Explore and filter all failed payments — click any row to expand its full trace: classification, verification, strategy advice, and the recovery attempts that followed.
        </p>
      </header>

      {/* Filter Bar */}
      <div className="filter-bar">
        <div className="filter-input-wrap">
          <Search size={16} aria-hidden="true" />
          <input
            type="text"
            className="filter-input"
            placeholder="Search by payment ID or amount..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <select className="filter-select" value={status} onChange={(e) => handleStatusChange(e.target.value)}>
          <option value="all">All statuses</option>
          <option value="recovered">Recovered</option>
          <option value="lost">Lost</option>
          <option value="pending">Pending</option>
          <option value="awaiting">Awaiting recovery</option>
        </select>

        <select className="filter-select" value={reason} onChange={(e) => handleReasonChange(e.target.value)}>
          <option value="all">All reasons</option>
          {allReasonsList.map((r) => (
            <option key={r} value={r}>
              {humanizeReason(r)}
            </option>
          ))}
        </select>

        <select className="filter-select" value={strategy} onChange={(e) => handleStrategyChange(e.target.value)}>
          <option value="all">All strategies</option>
          <option value="auto_retry">Automatic retry</option>
          <option value="payment_link">Payment link</option>
          <option value="alt_method">Alternate method</option>
        </select>

        {hasActiveFilters && (
          <button type="button" className="clear-filters-btn" onClick={clearFilters}>
            <X size={14} aria-hidden="true" /> Clear filters
          </button>
        )}
      </div>

      {state === 'ready' && (
        <div className="journeys-meta-bar">
          <span>
            {total > 0 ? `Showing ${traces.length} of ${total} ${total === 1 ? 'payment' : 'payments'}` : '0 payments'}
          </span>
        </div>
      )}

      {state === 'loading' && (
        <div className="traces" aria-busy="true" aria-live="polite">
          <span className="sr-only">Loading recovery journeys</span>
          {[0, 1, 2, 3].map((i) => (
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
        <div className="zero">
          {hasActiveFilters ? (
            <div>
              <p>No payments match your current filters.</p>
              <button type="button" className="clear-filters-btn" style={{ marginTop: 12 }} onClick={clearFilters}>
                <X size={14} aria-hidden="true" /> Clear filters
              </button>
            </div>
          ) : (
            <p className="muted">No payments yet. Trigger one from the Checkout page and it will appear here.</p>
          )}
        </div>
      )}

      {state === 'ready' && traces.length > 0 && (
        <>
          <div className="traces">
            {traces.map((t) => (
              <TraceCard key={t.razorpay_payment_id} t={t} />
            ))}
          </div>

          {traces.length < total && (
            <div className="load-more-wrap">
              <button type="button" onClick={() => setLimit((l) => l + 20)} disabled={isFetchingMore}>
                {isFetchingMore ? (
                  <>
                    <RefreshCw size={15} className="spin" /> Loading...
                  </>
                ) : (
                  `Load more (${total - traces.length} remaining)`
                )}
              </button>
            </div>
          )}
        </>
      )}
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
