import { useEffect, useState } from 'react'

const COLS = [
  'razorpay_payment_id',
  'amount',
  'currency',
  'error_code',
  'error_description',
  'status',
  'failure_reason',
  'confidence',
  'suggested_strategy',
  'provider_used',
  'created_at',
] as const

type Payment = Record<(typeof COLS)[number], string | number | null>

export default function PaymentsDebug() {
  const [rows, setRows] = useState<Payment[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [err, setErr] = useState('')

  async function load() {
    setState('loading')
    try {
      const res = await fetch('/api/debug/payments')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'fetch failed')
      setRows(data as Payment[])
      setState('ready')
    } catch (e: any) {
      setErr(e.message)
      setState('error')
    }
  }

  useEffect(() => {
    load()
  }, [])

  return (
    <div style={{ padding: 24, fontFamily: 'monospace' }}>
      <h1>Payments (Phase 1 debug)</h1>
      <p><a href="/debug/checkout">→ Test checkout (trigger a payment)</a></p>
      <button onClick={load} disabled={state === 'loading'}>
        Refresh
      </button>

      {state === 'loading' && <p>Loading…</p>}
      {state === 'error' && <p style={{ color: 'crimson' }}>Query failed: {err}</p>}
      {state === 'ready' && rows.length === 0 && (
        <p>No payments yet — trigger a test webhook.</p>
      )}

      {state === 'ready' && rows.length > 0 && (
        <table border={1} cellPadding={6} style={{ borderCollapse: 'collapse', marginTop: 12 }}>
          <thead>
            <tr>{COLS.map((c) => <th key={c}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {COLS.map((c) => <td key={c}>{r[c] ?? '—'}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
