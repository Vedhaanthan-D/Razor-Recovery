import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Sparkles, MessageCircle, Send } from 'lucide-react'

// Read-only AI panel for the whole dashboard. Two parts, one section:
//   1. the one-line AI summary (GET /api/insights, cached 5 min server-side — fetched once on mount)
//   2. "Ask about this data" — a BOUNDED Q&A box (POST /api/insights/ask) that only answers from the
//      app's own aggregate + recent traces. Not a chatbot; the backend refuses anything out of scope.
// Q&A pairs are kept in local state for this session only (no persistence across reloads, by design).

const MAX_LEN = 300 // mirrors the backend cap so the input can't outgrow what /ask accepts

type QA = { id: number; q: string; a: string; error?: boolean }

type InsightsPanelProps = {
  initialSummary?: string
}

export default function InsightsPanel({ initialSummary }: InsightsPanelProps) {
  const [summary, setSummary] = useState(initialSummary || '')
  const [isAi, setIsAi] = useState(false)

  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [qas, setQas] = useState<QA[]>([])
  const idRef = useRef(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  // Keep initialSummary in sync if initial load completes after component mount
  useEffect(() => {
    if (initialSummary && !isAi) {
      setSummary(initialSummary)
    }
  }, [initialSummary, isAi])

  // Simultaneously fire GET /api/insights in background without blocking initial render
  useEffect(() => {
    let alive = true
    fetch('/api/insights')
      .then((r) => r.json().then((b) => { if (!r.ok) throw new Error(b.error || 'failed'); return b }))
      .then((b) => {
        if (alive && b.summary) {
          setSummary(b.summary)
          setIsAi(true)
        }
      })
      .catch(() => {
        // Safe fallback: numbers-only summary remains permanently displayed if AI call fails
      })
    return () => { alive = false }
  }, [])

  // Keep the newest Q&A pair (or the "Thinking…" line) in view as the list grows.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [qas, asking])

  async function ask(e: FormEvent) {
    e.preventDefault()
    const q = question.trim()
    if (!q || asking) return
    const id = ++idRef.current
    setAsking(true)
    setQuestion('')
    try {
      const res = await fetch('/api/insights/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Could not answer that right now.')
      setQas((prev) => [...prev, { id, q, a: body.answer || '' }])
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Something went wrong.'
      setQas((prev) => [...prev, { id, q, a: msg, error: true }])
    } finally {
      setAsking(false)
    }
  }

  const summaryText = summary || initialSummary || 'Summary unavailable right now.'

  return (
    <section className="insight insight-panel">
      <div className="insight-row">
        <span className="insight-tag"><Sparkles size={14} /> AI insight</span>
        <span>{summaryText}</span>
      </div>

      <div className="ask">
        <label className="ask-label" htmlFor="ask-input"><MessageCircle size={13} /> Ask about this data</label>
        <form className="ask-form" onSubmit={ask}>
          <input
            id="ask-input"
            className="ask-input"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={MAX_LEN}
            placeholder="e.g. which failure reason is most common?"
            disabled={asking}
            autoComplete="off"
          />
          <button type="submit" className="primary" disabled={asking || !question.trim()}>
            <Send size={15} /> Ask
          </button>
        </form>

        {(qas.length > 0 || asking) && (
          <div className="qa-list" ref={listRef}>
            {qas.map((qa) => (
              <div className="qa" key={qa.id}>
                <p className="qa-q"><MessageCircle size={13} /> {qa.q}</p>
                <p className={qa.error ? 'qa-a qa-a-error' : 'qa-a'}>{qa.a}</p>
              </div>
            ))}
            {asking && <p className="qa-pending muted">Thinking…</p>}
          </div>
        )}
      </div>
    </section>
  )
}
