import { StrictMode, Suspense, lazy, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import JobWorkspace from './JobWorkspace.jsx'
import { navigateWorkspace } from './workspaceNavigation'

const Monitor = lazy(() => import('./App.jsx'))

export default function WorkspaceRouter() {
  const [workspace, setWorkspace] = useState(() => new URLSearchParams(window.location.search).get('workspace'))
  useEffect(() => {
    const update = () => setWorkspace(new URLSearchParams(window.location.search).get('workspace'))
    window.addEventListener('popstate', update)
    return () => window.removeEventListener('popstate', update)
  }, [])
  if (workspace !== 'monitor') return <JobWorkspace />
  return <><Suspense fallback={<div className="jw-route-loading" role="status">Opening world monitor…</div>}><Monitor /></Suspense><a className="jw-monitor-switch" href="?workspace=jobs" onClick={event => { event.preventDefault(); navigateWorkspace('jobs') }}>← Career workspace</a></>
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <WorkspaceRouter />
  </StrictMode>,
)
