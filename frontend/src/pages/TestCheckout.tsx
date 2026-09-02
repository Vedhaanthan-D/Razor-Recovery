import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { CreditCard, AlertTriangle } from 'lucide-react'

const FAIL_CARD = '4000 0000 0000 0002'
const REDIRECT_SECONDS = 5

// Promoted from the Phase-1 debug page: same Razorpay flow, themed as a real page.
export default function TestCheckout() {
  const navigate = useNavigate()
  const [amount, setAmount] = useState(500)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  // null = idle; a number = counting down before auto-redirecting to the Dashboard.
  const [countdown, setCountdown] = useState<number | null>(null)
  const redirectStartedRef = useRef(false)

  // Load Razorpay Checkout.js once.
  useEffect(() => {
    if (document.getElementById('razorpay-checkout-js')) return
    const s = document.createElement('script')
    s.id = 'razorpay-checkout-js'
    s.src = 'https://checkout.razorpay.com/v1/checkout.js'
    document.body.appendChild(s)
  }, [])

  // Drives the post-checkout redirect. Ticks the countdown down once a second, then
  // navigates at 0. Kept out of the state updater so navigate() isn't a render side effect;
  // the cleanup clears the pending timer, so leaving the page mid-countdown (a manual nav)
  // never fires a stray redirect afterwards.
  useEffect(() => {
    if (countdown === null) return
    if (countdown === 0) { navigate('/'); return }
    const t = setTimeout(() => setCountdown((n) => (n === null ? null : n - 1)), 1000)
    return () => clearTimeout(t)
  }, [countdown, navigate])

  // Fires when the checkout modal closes or fails — on a completed attempt (Razorpay `handler`),
  // dismiss without paying (`modal.ondismiss`), OR payment failure (`payment.failed`).
  // Idempotent — guarded by redirectStartedRef so repeated events don't restart or stack timers.
  const startRedirect = () => {
    if (redirectStartedRef.current) return
    redirectStartedRef.current = true
    setCountdown(REDIRECT_SECONDS)
  }

  async function pay() {
    redirectStartedRef.current = false
    setCountdown(null)   // a fresh attempt cancels any in-flight redirect
    setStatus('')
    setBusy(true)
    try {
      const res = await fetch('/api/debug/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'order create failed')

      const Razorpay = (window as any).Razorpay
      if (!Razorpay) throw new Error('Razorpay script not loaded yet — wait a second and retry')

      const rzp = new Razorpay({
        key: data.key_id,
        order_id: data.order_id,
        amount: data.amount,
        currency: data.currency,
        name: 'Razor Recovery Payment',
        description: 'Payment Transaction',
        handler: startRedirect,
        modal: { ondismiss: startRedirect },
      })
      rzp.on('payment.failed', function () {
        startRedirect()
      })
      rzp.open()
    } catch (e: any) {
      setStatus('Error: ' + e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dash page-narrow">
      <header className="page-head">
        <h1><CreditCard size={26} /> Test checkout</h1>
        <p className="muted">Trigger a real Razorpay payment to exercise the recovery pipeline end to end.</p>
      </header>

      <section className="panel">
        <div className="hint">
          <AlertTriangle size={18} />
          <span>To simulate a <b>failed</b> payment, use card <b>{FAIL_CARD}</b>, any future expiry, any CVV.</span>
        </div>

        <label className="field">
          <span>Amount (₹)</span>
          <input type="number" min={1} value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
        </label>

        <button className="primary" onClick={pay} disabled={busy}>{busy ? 'Opening…' : 'Create test payment'}</button>

        {countdown !== null ? (
          <div className="status-msg" role="status" aria-live="polite">
            {/* Deliberately does NOT claim success/failure — the outcome isn't known
                client-side yet. The Dashboard is the source of truth once we land. */}
            Checkout closed — see the live result on the dashboard.
            <p className="muted small" style={{ marginTop: 6 }}>
              Redirecting in {countdown}…{' '}
              <a href="/" onClick={(e) => { e.preventDefault(); navigate('/') }}>Skip to dashboard now</a>
            </p>
          </div>
        ) : status ? (
          <p className="status-msg">{status}</p>
        ) : null}
      </section>

      <p className="muted small">Raw data verification: <a href="/debug/payments">/debug/payments</a></p>
    </div>
  )
}
