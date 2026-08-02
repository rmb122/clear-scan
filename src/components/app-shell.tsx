import { Code2, FolderClock, Home, ScanLine, ShieldCheck } from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { Toaster } from 'sonner'
import { BrandLogo } from './brand-logo'
import { InstallButton, OnlineBadge, PwaLifecycle } from './pwa-controls'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const navItems = [
  { to: '/', label: '首页', icon: Home, exact: true },
  { to: '/history', label: '扫描记录', icon: FolderClock },
]

export function AppShell() {
  const location = useLocation()
  const scannerRoute = location.pathname.startsWith('/scan/') || location.pathname.startsWith('/project/')

  return (
    <div className="min-h-svh">
      <PwaLifecycle />
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/88 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1480px] items-center justify-between px-4 sm:px-6 lg:px-8">
          <NavLink to="/" aria-label="清晰扫描首页">
            <BrandLogo />
          </NavLink>
          <nav className="hidden items-center gap-1 md:flex">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.exact}
                className={({ isActive }) =>
                  cn(
                    'flex h-9 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-muted-foreground transition hover:bg-muted hover:text-foreground',
                    isActive && 'bg-secondary text-secondary-foreground',
                  )
                }
              >
                <item.icon className="size-4" />
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-1 sm:gap-2">
            <OnlineBadge />
            <span className="hidden items-center gap-1.5 text-[11px] font-semibold text-muted-foreground lg:flex">
              <ShieldCheck className="size-3.5 text-primary" /> 图片仅在本机处理
            </span>
            <Button asChild variant="ghost" size="icon" className="sm:hidden">
              <a
                href="https://github.com/rmb122/clear-scan"
                target="_blank"
                rel="noreferrer"
                aria-label="查看项目源代码"
              >
                <Code2 />
              </a>
            </Button>
            <Button asChild variant="outline" size="sm" className="hidden text-sm sm:inline-flex">
              <a
                href="https://github.com/rmb122/clear-scan"
                target="_blank"
                rel="noreferrer"
                aria-label="查看项目源代码"
              >
                <Code2 /> 源代码
              </a>
            </Button>
            <InstallButton />
          </div>
        </div>
      </header>

      <main className={cn(scannerRoute ? 'w-full' : 'mx-auto max-w-7xl px-4 sm:px-6 lg:px-8')}>
        <Outlet />
      </main>

      <nav
        aria-label="移动端主导航"
        className="safe-bottom fixed inset-x-0 bottom-0 z-40 grid h-[calc(4rem+env(safe-area-inset-bottom))] grid-cols-3 border-t border-border bg-background/95 px-4 pt-2 backdrop-blur-xl md:hidden"
      >
        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            cn(
              'col-start-1 flex flex-col items-center gap-1 py-1 text-[10px] font-semibold text-muted-foreground',
              isActive && 'text-primary',
            )
          }
        >
          <Home className="size-5" />
          首页
        </NavLink>
        <NavLink
          to="/scan/document"
          className="absolute left-1/2 top-0 flex -translate-x-1/2 -translate-y-5 flex-col items-center gap-1 text-[10px] font-semibold text-primary"
        >
          <span className="grid size-12 place-items-center rounded-2xl bg-primary text-white shadow-[0_8px_24px_rgba(8,127,91,.28)]">
            <ScanLine className="size-5" />
          </span>
          扫一扫
        </NavLink>
        <NavLink
          to="/history"
          className={({ isActive }) =>
            cn(
              'col-start-3 flex flex-col items-center gap-1 py-1 text-[10px] font-semibold text-muted-foreground',
              isActive && 'text-primary',
            )
          }
        >
          <FolderClock className="size-5" />
          记录
        </NavLink>
      </nav>
      <Toaster position="top-center" richColors closeButton />
    </div>
  )
}
