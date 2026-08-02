import { lazy, Suspense } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from '@/components/app-shell'

const HomePage = lazy(() => import('@/pages/home-page').then((module) => ({ default: module.HomePage })))
const HistoryPage = lazy(() => import('@/pages/history-page').then((module) => ({ default: module.HistoryPage })))
const ScanPage = lazy(() => import('@/pages/scan-page').then((module) => ({ default: module.ScanPage })))

export default function App() {
  return (
    <HashRouter>
      <Suspense
        fallback={
          <div className="grid min-h-svh place-items-center text-sm font-semibold text-muted-foreground">
            正在打开扫描仪…
          </div>
        }
      >
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<HomePage />} />
            <Route path="history" element={<HistoryPage />} />
            <Route path="scan/:mode" element={<ScanPage />} />
            <Route path="project/:projectId" element={<ScanPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </HashRouter>
  )
}
