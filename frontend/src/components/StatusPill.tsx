import { CheckCircle2, XCircle, Clock, MinusCircle } from 'lucide-react'

// Shared status pill so the green/amber/red iconography is identical on the dashboard and the
// agent traces. success → green, failed/lost → red, anything else (pending) → amber, none → grey.
export default function StatusPill({ status }: { status: string | null }) {
  if (!status) return <span className="pill none"><MinusCircle size={13} /> none</span>
  if (status === 'success') return <span className="pill ok"><CheckCircle2 size={13} /> {status}</span>
  if (status === 'failed' || status === 'lost') return <span className="pill fail"><XCircle size={13} /> {status}</span>
  return <span className="pill pending"><Clock size={13} /> {status}</span>
}
