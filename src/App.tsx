import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from '@/components/app-shell'

const HomePage = lazy(() => import('@/pages/home-page').then((module) => ({ default: module.HomePage })))
const HistoryPage = lazy(() => import('@/pages/history-page').then((module) => ({ default: module.HistoryPage })))
const ScanPage = lazy(() => import('@/pages/scan-page').then((module) => ({ default: module.ScanPage })))
const SettingsPage = lazy(() => import('@/pages/settings-page').then((module) => ({ default: module.SettingsPage })))

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<div className="grid min-h-svh place-items-center text-sm font-semibold text-muted-foreground">正在打开扫描仪…</div>}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<HomePage />} />
            <Route path="history" element={<HistoryPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="scan/:mode" element={<ScanPage />} />
            <Route path="project/:projectId" element={<ScanPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}
