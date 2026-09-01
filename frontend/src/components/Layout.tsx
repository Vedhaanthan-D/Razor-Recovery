import { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { LayoutDashboard, CreditCard, Workflow, Network, Sun, Moon } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import logoImg from '../assets/logo.png'

// Persistent top nav shown on the 4 themed pages. Debug pages render outside this layout, so they
// stay chrome-free. Active page is highlighted via NavLink's isActive.
const NAV: { to: string; label: string; icon: LucideIcon; end?: boolean }[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/checkout', label: 'Checkout', icon: CreditCard },
  { to: '/agents', label: 'Recovery Journeys', icon: Workflow },
  { to: '/how-it-works', label: 'How It Works', icon: Network },
]

export default function Layout() {
  return (
    <div className="app">
      <nav className="nav">
        <NavLink to="/" className="nav-brand" aria-label="Razor Recovery Home">
          <img src={logoImg} alt="Razor Recovery" className="nav-logo" />
        </NavLink>
        <div className="nav-right">
          <div className="nav-links">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink key={to} to={to} end={end} className={({ isActive }) => 'navlink' + (isActive ? ' active' : '')}>
                <Icon size={17} />
                <span>{label}</span>
              </NavLink>
            ))}
          </div>
          <ThemeToggle />
        </div>
      </nav>
      <main className="page-wrap">
        <Outlet />
      </main>
    </div>
  )
}

// Light-first theme switch. Light is the default; dark is opt-in and persisted so a returning
// visitor keeps their choice. The pre-paint script in index.html sets the initial attribute; this
// just keeps <html data-theme> and localStorage in sync with the toggle. Not a business concern —
// no data or routes touched.
function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
  )

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') root.setAttribute('data-theme', 'dark')
    else root.removeAttribute('data-theme')
    try { localStorage.setItem('theme', theme) } catch { /* storage may be unavailable */ }
  }, [theme])

  const dark = theme === 'dark'
  const label = dark ? 'Switch to light theme' : 'Switch to dark theme'
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => setTheme(dark ? 'light' : 'dark')}
      aria-label={label}
      title={label}
    >
      {dark ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  )
}
