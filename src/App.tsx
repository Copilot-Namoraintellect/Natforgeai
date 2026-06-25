import { Routes, Route, Navigate } from 'react-router'
import { Suspense, lazy } from 'react'
import { AppLayout } from './components/layout/AppLayout'
import Home from './pages/Home'
import Login from './pages/Login'
import Pricing from './pages/Pricing'
import Privacy from './pages/Privacy'
import Terms from './pages/Terms'
import DataDeletion from './pages/DataDeletion'
import NotFound from './pages/NotFound'

const MissionControl = lazy(() => import('./pages/MissionControl'))
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
const Onboarding = lazy(() => import('./pages/Onboarding'))
const ApprovalCentre = lazy(() => import('./pages/ApprovalCentre'))
const AgentActivity = lazy(() => import('./pages/AgentActivity'))
const AudienceIntelligence = lazy(() => import('./pages/AudienceIntelligence'))
const Integrations = lazy(() => import('./pages/Integrations'))
const AutonomousSettings = lazy(() => import('./pages/AutonomousSettings'))
const Credits = lazy(() => import('./pages/Credits'))
const SystemHealth = lazy(() => import('./pages/SystemHealth'))
const AdminAlerts = lazy(() => import('./pages/AdminAlerts'))

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/pricing" element={<Pricing />} />
      <Route path="/privacy" element={<Privacy />} />
      <Route path="/terms" element={<Terms />} />
      <Route path="/data-deletion" element={<DataDeletion />} />
      <Route element={<AppLayout />}>
        <Route path="/dashboard" element={<Suspense fallback={<PageLoader />}><Navigate to="/mission-control" replace /></Suspense>} />
        <Route path="/mission-control" element={<Suspense fallback={<PageLoader />}><MissionControl /></Suspense>} />
        <Route path="/campaigns" element={<Suspense fallback={<PageLoader />}><Campaigns /></Suspense>} />
        <Route path="/content" element={<Suspense fallback={<PageLoader />}><ContentStudio /></Suspense>} />
        <Route path="/calendar" element={<Suspense fallback={<PageLoader />}><Calendar /></Suspense>} />
        <Route path="/leads" element={<Suspense fallback={<PageLoader />}><Leads /></Suspense>} />
        <Route path="/automations" element={<Suspense fallback={<PageLoader />}><Automations /></Suspense>} />
        <Route path="/templates" element={<Suspense fallback={<PageLoader />}><Templates /></Suspense>} />
        <Route path="/analytics" element={<Suspense fallback={<PageLoader />}><Analytics /></Suspense>} />
        <Route path="/settings" element={<Suspense fallback={<PageLoader />}><Settings /></Suspense>} />
        <Route path="/approvals" element={<Suspense fallback={<PageLoader />}><ApprovalCentre /></Suspense>} />
        <Route path="/agent-activity" element={<Suspense fallback={<PageLoader />}><AgentActivity /></Suspense>} />
        <Route path="/audience-intelligence" element={<Suspense fallback={<PageLoader />}><AudienceIntelligence /></Suspense>} />
        <Route path="/integrations" element={<Suspense fallback={<PageLoader />}><Integrations /></Suspense>} />
        <Route path="/autonomous-settings" element={<Suspense fallback={<PageLoader />}><AutonomousSettings /></Suspense>} />
        <Route path="/credits" element={<Suspense fallback={<PageLoader />}><Credits /></Suspense>} />
        <Route path="/admin/system-health" element={<Suspense fallback={<PageLoader />}><SystemHealth /></Suspense>} />
        <Route path="/admin/alerts" element={<Suspense fallback={<PageLoader />}><AdminAlerts /></Suspense>} />
        <Route path="/admin" element={<Suspense fallback={<PageLoader />}><Admin /></Suspense>} />
        <Route path="/banking" element={<Suspense fallback={<PageLoader />}><Banking /></Suspense>} />
        <Route path="/onboarding" element={<Suspense fallback={<PageLoader />}><Onboarding /></Suspense>} />
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
