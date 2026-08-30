import { Tag, ShieldCheck, Scale, Sparkles, Layers, Cpu, ArrowRight, Network, Workflow } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Link } from 'react-router-dom'

// "How It Works" — a static, no-API page tuned for a 15-second read: what this system is and how a
// failed payment turns into a recovery attempt. Deliberately shallow. Anything deeper — a real
// payment's actual trace, per-provider detail, the escalation that really happened — lives on Recovery
// Journeys, where it can be shown on live data instead of described here.

// The precise step sequence (agent = judgment, infra = deterministic plumbing).
const PIPELINE: { label: string; kind: 'infra' | 'agent' }[] = [
  { label: 'Webhook', kind: 'infra' },
  { label: 'Classify', kind: 'agent' },
  { label: 'Verify', kind: 'agent' },
  { label: 'Advise', kind: 'agent' },
  { label: 'Orchestrate', kind: 'infra' },
  { label: 'Recover', kind: 'infra' },
  { label: 'Dashboard', kind: 'infra' },
]

// The same flow as a friendly left-to-right story, rendered as one clean SVG. Each beat is captioned in
// plain English; Verify is dashed because it only runs when the first guess is uncertain.
const FLOW: { title: string; cap: string; kind: 'start' | 'agent' | 'infra' | 'end'; optional?: boolean }[] = [
  { title: 'Payment fails', cap: 'webhook', kind: 'start' },
  { title: 'Classify', cap: 'why it failed', kind: 'agent' },
  { title: 'Verify', cap: 'if unsure', kind: 'agent', optional: true },
  { title: 'Advise', cap: 'best fix', kind: 'agent' },
  { title: 'Recover', cap: 'retry → link → alt', kind: 'infra' },
  { title: 'Dashboard', cap: '+ AI summary', kind: 'end' },
]

// One line each — no triggers, no internals. The technical depth belongs on Recovery Journeys.
const AGENTS: { name: string; icon: LucideIcon; line: string }[] = [
  { name: 'Classification', icon: Tag, line: 'figures out why it failed.' },
  { name: 'Verifier', icon: ShieldCheck, line: 'double-checks when unsure.' },
  { name: 'Advisor', icon: Scale, line: "picks the strategy that's worked best before." },
  { name: 'Insights', icon: Sparkles, line: 'summarizes it all in plain English.' },
]

// SVG flow geometry, in viewBox units. The SVG scales to its container width and scrolls on narrow
// screens (see .flow-wrap), so these numbers just fix the aspect ratio and node spacing.
const N_W = 122
const N_H = 44
const GAP = 34
const LEFT = 19
const TOP = 24
const CY = TOP + N_H / 2
const nodeLeft = (i: number) => LEFT + i * (N_W + GAP)
const VIEW_W = nodeLeft(FLOW.length - 1) + N_W + LEFT

export default function Architecture() {
  return (
    <div className="dash">
      <header className="page-head">
        <h1><Network size={26} /> How It Works</h1>
        <p className="muted">A failed payment, recovered automatically — the whole flow at a glance.</p>
      </header>

      {/* The flow — one clean picture is the point of this page. */}
      <section className="panel">
        <h2><Workflow size={18} /> The flow</h2>
        <div className="flow-wrap">
          <svg
            className="flow"
            viewBox={`0 0 ${VIEW_W} 108`}
            role="img"
            aria-label="A payment fails, then Classify works out why, Verify double-checks if unsure, Advise picks the best fix, Recover escalates from retry to payment link to alternate method, and the outcome plus an AI summary land on the dashboard."
          >
            <defs>
              <marker id="flow-arrow" viewBox="0 0 8 8" refX="6.5" refY="4" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" className="flow-arrowhead" />
              </marker>
            </defs>

            {/* arrows between consecutive nodes */}
            {FLOW.slice(1).map((_, k) => {
              const i = k + 1
              return (
                <line
                  key={`arrow-${i}`}
                  className="flow-arrow"
                  x1={nodeLeft(i - 1) + N_W + 4}
                  y1={CY}
                  x2={nodeLeft(i) - 6}
                  y2={CY}
                  markerEnd="url(#flow-arrow)"
                />
              )
            })}

            {/* nodes + captions */}
            {FLOW.map((n, i) => {
              const cx = nodeLeft(i) + N_W / 2
              return (
                <g key={n.title}>
                  <rect
                    className={`flow-node ${n.kind}${n.optional ? ' optional' : ''}`}
                    x={nodeLeft(i)}
                    y={TOP}
                    width={N_W}
                    height={N_H}
                    rx={9}
                  />
                  <text className={`flow-title${n.kind === 'agent' ? ' agent' : ''}`} x={cx} y={CY} textAnchor="middle" dominantBaseline="central">
                    {n.title}
                  </text>
                  <text className="flow-cap" x={cx} y={CY + N_H / 2 + 18} textAnchor="middle">
                    {n.cap}
                  </text>
                </g>
              )
            })}
          </svg>
        </div>
      </section>

      {/* The agents — one line each, no triggers. */}
      <section className="panel">
        <h2><Cpu size={18} /> The four agents</h2>
        <ul className="agent-lines">
          {AGENTS.map(({ name, icon: Icon, line }) => (
            <li key={name}>
              <span className="step-icon accent"><Icon size={15} /></span>
              <span><b>{name}</b> — {line}</span>
            </li>
          ))}
        </ul>
        <p className="muted small agent-lines-note">
          Everything else — the webhook, the orchestrator, the recovery calls — is deterministic plumbing
          that sequences these decisions; it doesn&rsquo;t make them.
        </p>
      </section>

      {/* Pipeline overview — kept: the precise step sequence, agent vs. infrastructure. */}
      <section className="panel">
        <h2><Layers size={18} /> Pipeline overview</h2>
        <div className="pipeline">
          {PIPELINE.map((p, i) => (
            <span className="pipe-node-wrap" key={p.label}>
              {i > 0 && <ArrowRight size={16} className="pipe-arrow" />}
              <span className={`pipe-node ${p.kind}`}>{p.label}</span>
            </span>
          ))}
        </div>
        <p className="muted small legend">
          <span className="dot agent" /> Agent (LLM / data-driven judgment) &nbsp;&nbsp;
          <span className="dot infra" /> Deterministic infrastructure
        </p>
      </section>

      {/* Go deeper: the same flow, on real payments. */}
      <Link className="journeys-cta" to="/agents">
        <span className="journeys-cta-text">
          <b>See it happen on real payments</b>
          <span className="muted small">Recovery Journeys traces each failed payment through every step above.</span>
        </span>
        <span className="journeys-cta-go">Recovery Journeys <ArrowRight size={16} /></span>
      </Link>
    </div>
  )
}
