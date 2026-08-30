import { useEffect, useState } from 'react'
import { CreditCard, AlertTriangle } from 'lucide-react'

const FAIL_CARD = '4000 0000 0000 0002'

// Promoted from the Phase-1 debug page: same Razorpay flow, themed as a real page.
export default function TestCheckout() {
  const [amount, setAmount] = useState(500)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  // Load Razorpay Checkout.js once.
  useEffect(() => {
    if (document.getElementById('razorpay-checkout-js')) return
    const s = document.createElement('script')
    s.id = 'razorpay-checkout-js'
    s.src = 'https://checkout.razorpay.com/v1/checkout.js'
    document.body.appendChild(s)
  }, [])

  async function pay() {
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

      // Failed payments never hit `handler`; the webhook is the source of truth. Same line either way.
      const done = () => setStatus('Checkout closed — watch it flow through the funnel on the Dashboard.')
      new Razorpay({
        key: data.key_id,
        order_id: data.order_id,
        amount: data.amount,
        currency: data.currency,
        name: 'Webhook Pipeline Test',
        handler: done,
        modal: { ondismiss: done },
      }).open()
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

        {status && <p className="status-msg">{status}</p>}
      </section>

      <p className="muted small">Raw data verification: <a href="/debug/payments">/debug/payments</a></p>
    </div>
  )
}
