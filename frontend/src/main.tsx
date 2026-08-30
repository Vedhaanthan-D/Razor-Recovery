import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
// Self-hosted variable fonts (bundled — no runtime request). Geist for UI, Geist Mono for IDs/codes.
import '@fontsource-variable/geist/wght.css'
import '@fontsource-variable/geist-mono/wght.css'
import './index.css'
import './App.css'
import Layout from './components/Layout.tsx'
import App from './App.tsx'
import TestCheckout from './pages/TestCheckout.tsx'
import RecoveryJourneys from './pages/RecoveryJourneys.tsx'
import Architecture from './pages/Architecture.tsx'
import PaymentsDebug from './pages/PaymentsDebug.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        {/* Themed product pages share the persistent nav via Layout. */}
        <Route element={<Layout />}>
          <Route path="/" element={<App />} />
          <Route path="/checkout" element={<TestCheckout />} />
          <Route path="/agents" element={<RecoveryJourneys />} />
          <Route path="/how-it-works" element={<Architecture />} />
          {/* Old path kept working after the "Architecture" → "How It Works" rename. */}
          <Route path="/architecture" element={<Navigate to="/how-it-works" replace />} />
        </Route>
        {/* Debug page stays raw/utilitarian — no nav, no theme. */}
        <Route path="/debug/payments" element={<PaymentsDebug />} />
        {/* Old debug checkout path now points at the promoted page. */}
        <Route path="/debug/checkout" element={<Navigate to="/checkout" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
