import { Routes, Route } from 'react-router'
import { Suspense, lazy } from 'react'
import { AppLayout } from './components/layout/AppLayout'
import Home from './pages/Home'
import Login from './pages/Login'
import Pricing from './pages/Pricing'
import NotFound from './pages/NotFound'

const Dashboard = lazy(() => import('./pages/Dashboard'))
const Campaigns = lazy(() => import('./pages/Campaigns'))
const ContentStudio = lazy(() => import('./pages/ContentStudio'))
const Calendar = lazy(() => import('./pages/Calendar'))
const Leads = lazy(() => import('./pages/Leads'))
const Automations = lazy(() => import('./pages/Automations'))
const Templates = lazy(() => import('./pages/Templates'))
const Analytics = lazy(() => import('./pages/Analytics'))
const Settings = lazy(() => import('./pages/Settings'))
const Admin = lazy(() => import('./pages/Admin'))
const Banking = lazy(() => import('./pages/Banking'))

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/pricing" element={<Pricing />} />
      <Route element={<AppLayout />}>
        <Route path="/dashboard" element={<Suspense fallback={<PageLoader />}><Dashboard /></Suspense>} />
        <Route path="/campaigns" element={<Suspense fallback={<PageLoader />}><Campaigns /></Suspense>} />
        <Route path="/content" element={<Suspense fallback={<PageLoader />}><ContentStudio /></Suspense>} />
        <Route path="/calendar" element={<Suspense fallback={<PageLoader />}><Calendar /></Suspense>} />
        <Route path="/leads" element={<Suspense fallback={<PageLoader />}><Leads /></Suspense>} />
        <Route path="/automations" element={<Suspense fallback={<PageLoader />}><Automations /></Suspense>} />
        <Route path="/templates" element={<Suspense fallback={<PageLoader />}><Templates /></Suspense>} />
        <Route path="/analytics" element={<Suspense fallback={<PageLoader />}><Analytics /></Suspense>} />
        <Route path="/settings" element={<Suspense fallback={<PageLoader />}><Settings /></Suspense>} />
        <Route path="/admin" element={<Suspense fallback={<PageLoader />}><Admin /></Suspense>} />
        <Route path="/banking" element={<Suspense fallback={<PageLoader />}><Banking /></Suspense>} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}

function PageLoader() {
  return (
    <div className="flex h-full w-full items-center justify-center min-h-[60vh]">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    </div>
  )
}
