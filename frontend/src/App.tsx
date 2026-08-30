import { useEffect, useState } from 'react'
import { CheckCircle2, XCircle, Percent, Filter, AlertTriangle, BarChart3, Activity, Info, ExternalLink, RefreshCw } from 'lucide-react'
import StatusPill from './components/StatusPill'
import InsightsPanel from './components/InsightsPanel'
import './App.css'

// Shape returned by GET /api/dashboard (see Backend/src/routes/dashboard.js).
type Dashboard = {
  funnel: { failed: number; classified: number; recovery_attempted: number; recovered: number }
  money: { recovered: number; lost: number; currency: string }
  by_reason: { reason: string; count: number }[]
  by_strategy: { strategy: string; attempted: number; succeeded: number; success_rate: number }[]
  recent: Recent[]
}

type Recent = {
  razorpay_payment_id: string
  amount: number | null
  currency: string | null
  error_code: string | null
  error_description: string | null
  status: string | null
  created_at: string | null
  failure_reason: string | null
  detail: string | null
  confidence: number | null
  suggested_strategy: string | null
  provider_used: string | null
  advisor_note: string | null
  recovery_strategy: string | null
  recovery_status: string | null
  recovered_amount: number | null
  recovery_notes: string | null
}

const POLL_MS = 5000

function money(n: number, currency: string) {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n)
  } catch {
    return `${currency} ${n.toFixed(0)}`
  }
}

// Pull the first URL out of a recovery note like "Payment link sent: https://rzp.io/i/XXXX".
function payLink(notes: string | null): string | null {
  if (!notes) return null
  const m = notes.match(/https?:\/\/\S+/)
  return m ? m[0] : null
}

// Display-label helpers, shared with RecoveryJourneys (imported from here — single source of truth).
// raw failure-reason enum → human text: insufficient_funds → "insufficient funds". The expanded
// RecoveryJourneys panel still shows the raw enum as a chip alongside the humanized one-liner.
export const humanizeReason = (r: string) => r.replace(/_/g, ' ')

// Recovery-strategy enums → plain labels for PRIMARY display text; unmapped values pass through, null → '—'.
const STRATEGY_LABELS: Record<string, string> = {
  auto_retry: 'Automatic retry',
  payment_link: 'Payment link',
  alt_method: 'Alternate method',
}
export function strategyLabel(s: string | null | undefined) {
  return s ? (STRATEGY_LABELS[s] || s) : '—'
}

// LLM provider/key ids → recognizable brand names (both Groq keys → "Groq"; OpenRouter serves Nemotron).
const PROVIDER_LABELS: Record<string, string> = {
  groq_key1: 'Groq',
  groq_key2: 'Groq',
  mistral: 'Mistral',
  openrouter: 'Nemotron',
  nemotron: 'Nemotron',
}
export function providerLabel(p: string | null | undefined) {
  return p ? (PROVIDER_LABELS[p] || p) : '—'
}

const FUNNEL_STAGES = [
  { key: 'failed', label: 'Failed' },
  { key: 'classified', label: 'Classified' },
  { key: 'recovery_attempted', label: 'Recovery attempted' },
  { key: 'recovered', label: 'Recovered' },
] as const

export default function App() {
  const [data, setData] = useState<Dashboard | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [err, setErr] = useState('')
  const [updated, setUpdated] = useState('')

  async function load() {
    try {
      const res = await fetch('/api/dashboard')
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'fetch failed')
      setData(body as Dashboard)
      setUpdated(new Date().toLocaleTimeString())
      setState('ready')
    } catch (e: any) {
      setErr(e.message)
      setState('error')
    }
  }

  // Poll so auto_retry resolutions (pending → success/failed) show up live during a demo.
  useEffect(() => {
    load()
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [])

  if (state === 'loading') return <DashboardSkeleton />
  if (state === 'error') return (
    <div className="dash">
      <header className="dash-head">
        <div>
          <h1>Recovery Agent</h1>
          <p className="muted">AI payment-failure recovery — live funnel</p>
        </div>
        <button onClick={load}><RefreshCw size={15} /> Retry</button>
      </header>
      <p className="err">Dashboard failed to load: {err}</p>
    </div>
  )
  if (!data) return null

  const { funnel, money: m, by_reason, by_strategy, recent } = data
  const max = Math.max(funnel.failed, 1)
  const totalMoney = m.recovered + m.lost
  const recoveryRate = funnel.failed ? Math.round((funnel.recovered / funnel.failed) * 100) : 0
  const empty = funnel.failed === 0

  return (
    <div className="dash">
      <header className="dash-head">
        <div>
          <h1>Recovery Agent</h1>
          <p className="muted">AI payment-failure recovery — live funnel</p>
        </div>
        <div className="head-actions">
          <span className="live small"><span className="live-dot" aria-hidden="true" />updated {updated}</span>
          <button onClick={load}><RefreshCw size={15} /> Refresh</button>
        </div>
      </header>

      {empty && (
        <p className="muted zero">
          No failed payments yet. Trigger one from the <a href="/checkout">Checkout</a> page, then
          watch it flow through the funnel here.
        </p>
      )}

      <InsightsPanel />

      {/* Money headline */}
      <section className="cards">
        <div className="card good">
          <span className="card-label"><CheckCircle2 size={14} /> Recovered</span>
          <span className="card-value">{money(m.recovered, m.currency)}</span>
        </div>
        <div className="card bad">
          <span className="card-label"><XCircle size={14} /> Lost (unrecovered)</span>
          <span className="card-value">{money(m.lost, m.currency)}</span>
        </div>
        <div className="card">
          <span className="card-label"><Percent size={14} /> Recovery rate</span>
          <span className="card-value">{recoveryRate}%</span>
          <span className="card-label small">{funnel.recovered} / {funnel.failed} payments</span>
        </div>
      </section>

      {/* Funnel */}
      <section className="panel">
        <h2><Filter size={18} /> Recovery funnel</h2>
        <div className="funnel">
          {FUNNEL_STAGES.map((s) => {
            const v = funnel[s.key]
            return (
              <div className="funnel-row" key={s.key}>
                <span className="funnel-label">{s.label}</span>
                <div className="bar-track">
                  <div className="bar" style={{ width: `${(v / max) * 100}%` }} />
                </div>
                <span className="funnel-count">{v}</span>
              </div>
            )
          })}
        </div>
      </section>

      <div className="two-col">
        {/* Failure reasons */}
        <section className="panel">
          <h2><AlertTriangle size={18} /> Failure reasons</h2>
          {by_reason.length === 0 ? <p className="muted">—</p> : (
            <div className="funnel">
              {by_reason.map((r) => {
                const rmax = by_reason[0].count || 1
                return (
                  <div className="funnel-row" key={r.reason}>
                    <span className="funnel-label mono">{humanizeReason(r.reason)}</span>
                    <div className="bar-track">
                      <div className="bar alt" style={{ width: `${(r.count / rmax) * 100}%` }} />
                    </div>
                    <span className="funnel-count">{r.count}</span>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* Strategy breakdown */}
        <section className="panel">
          <h2><BarChart3 size={18} /> Strategy performance</h2>
          {by_strategy.length === 0 ? <p className="muted">—</p> : (
            <table>
              <thead><tr><th>Strategy</th><th>Attempted</th><th>Succeeded</th><th>Success rate</th></tr></thead>
              <tbody>
                {by_strategy.map((s) => (
                  <tr key={s.strategy}>
                    <td className="mono">{strategyLabel(s.strategy)}</td>
                    <td>{s.attempted}</td>
                    <td>{s.succeeded}</td>
                    <td>{Math.round(s.success_rate * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {/* Recent activity */}
      <section className="panel">
        <h2><Activity size={18} /> Recent activity</h2>
        {recent.length === 0 ? <p className="muted">—</p> : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Payment</th><th>Amount</th><th>Error</th><th>Reason</th>
                  <th>Strategy</th><th>Recovery</th><th>When</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => {
                  const link = payLink(r.recovery_notes)
                  return (
                    <tr key={r.razorpay_payment_id}>
                      <td className="mono">{r.razorpay_payment_id}</td>
                      <td>{r.amount != null ? money(Number(r.amount), r.currency || m.currency) : '—'}</td>
                      <td className="mono small">{r.error_code || '—'}</td>
                      <td className="mono">
                        {r.failure_reason ? (
                          <span className="cell-hint" title={r.detail || undefined} style={{ cursor: r.detail ? 'help' : undefined }}>
                            {humanizeReason(r.failure_reason)}{r.detail ? <Info size={12} /> : null}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="mono">
                        {(r.recovery_strategy || r.suggested_strategy) ? (
                          <span className="cell-hint" title={r.advisor_note || undefined} style={{ cursor: r.advisor_note ? 'help' : undefined }}>
                            {strategyLabel(r.recovery_strategy || r.suggested_strategy)}{r.advisor_note ? <Info size={12} /> : null}
                          </span>
                        ) : '—'}
                      </td>
                      <td>
                        <StatusPill status={r.recovery_status} />
                        {link && (
                          <a className="cell-hint" href={link} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 8 }}>
                            <ExternalLink size={13} /> Pay link
                          </a>
                        )}
                      </td>
                      <td className="small">{r.created_at ? new Date(r.created_at).toLocaleString() : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <footer className="muted small foot">
        {totalMoney > 0 && <>Total at risk {money(totalMoney, m.currency)}</>}
      </footer>
    </div>
  )
}

// First-paint skeleton that mirrors the real dashboard's shape (header, insight, metric cards,
// funnel, two panels) so the layout doesn't jump when data arrives. Purely presentational.
function DashboardSkeleton() {
  return (
    <div className="dash" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading dashboard</span>
      <header className="dash-head">
        <div>
          <div className="skel skel-line lg" style={{ width: 210 }} />
          <div className="skel skel-line" style={{ width: 264, marginTop: 12 }} />
        </div>
        <div className="skel" style={{ width: 104, height: 38, borderRadius: 'var(--r-sm)' }} />
      </header>

      <div className="skel" style={{ height: 54, borderRadius: 'var(--r-lg)' }} />

      <section className="cards">
        {[0, 1, 2].map((i) => (
          <div className="skel-card" key={i}>
            <div className="skel skel-line sm" style={{ width: 100 }} />
            <div className="skel skel-line lg" style={{ width: 128 }} />
          </div>
        ))}
      </section>

      <section className="skel-panel">
        <div className="skel skel-line" style={{ width: 148 }} />
        <div className="skel-bars">
          {[0, 1, 2, 3].map((i) => (
            <div className="skel-bar-row" key={i}>
              <div className="skel skel-line sm" style={{ width: 118 }} />
              <div className="skel" style={{ height: 26, borderRadius: 'var(--r-xs)', width: `${92 - i * 18}%` }} />
            </div>
          ))}
        </div>
      </section>

      <div className="two-col">
        {[0, 1].map((p) => (
          <section className="skel-panel" key={p}>
            <div className="skel skel-line" style={{ width: 150 }} />
            <div className="skel-bars">
              {[0, 1, 2].map((i) => (
                <div className="skel-bar-row" key={i}>
                  <div className="skel skel-line sm" style={{ width: 104 }} />
                  <div className="skel" style={{ height: 26, borderRadius: 'var(--r-xs)', width: `${84 - i * 20}%` }} />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
