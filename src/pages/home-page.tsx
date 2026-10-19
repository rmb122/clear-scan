import {
  ArrowRight,
  Check,
  CreditCard,
  FileStack,
  FileText,
  LockKeyhole,
  Plane,
  ScanLine,
  ShieldCheck,
  Sparkles,
  WifiOff,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ProjectCard } from '@/components/project-card'
import { useScannerNavigation } from '@/hooks/use-scanner-navigation'
import { useProjectSummaries } from '@/hooks/use-projects'
import type { ScanMode } from '@/lib/types'
import { messages } from '@/lib/i18n'
import { useLocale } from '@/hooks/use-locale'

export function HomePage() {
  useLocale()
  const modes: Array<{
    mode: ScanMode
    title: string
    description: string
    detail: string
    icon: typeof CreditCard
  }> = [
    {
      mode: 'id-card',
      title: messages.idCardScan,
      description: messages.idCardDescription,
      detail: messages.idCardDetail,
      icon: CreditCard,
    },
    {
      mode: 'passport',
      title: messages.passportScan,
      description: messages.passportDescription,
      detail: messages.passportDetail,
      icon: Plane,
    },
    {
      mode: 'document',
      title: messages.documentScan,
      description: messages.documentDescription,
      detail: messages.documentDetail,
      icon: FileText,
    },
  ]
  const openScanner = useScannerNavigation()
  const { summaries, loading } = useProjectSummaries(4)

  return (
    <div className="pb-16 pt-6 sm:pt-10 lg:pb-20 lg:pt-12">
      <section className="relative overflow-hidden rounded-3xl border border-border bg-card px-5 py-7 sm:px-10 sm:py-10 lg:grid lg:grid-cols-[1.05fr_.95fr] lg:items-center lg:gap-10 lg:px-12 lg:py-12">
        <div className="relative z-10 max-w-2xl">
          <Badge className="mb-5">
            <ShieldCheck className="size-3.5" /> {messages.privacyBadge}
          </Badge>
          <h1 className="text-balance text-3xl font-bold leading-[1.2] tracking-tight sm:text-5xl lg:text-[3.25rem]">
            {messages.heroLead} <br className="hidden sm:block" />
            <span className="whitespace-nowrap">{messages.heroSecond}</span>{' '}
            <span className="whitespace-nowrap text-primary">{messages.heroHighlight}</span>
          </h1>
          <p className="mt-4 max-w-xl text-sm leading-7 text-muted-foreground sm:mt-5 sm:text-base">
            {messages.heroDescription}
          </p>
          <div className="mt-6 grid gap-3 min-[380px]:grid-cols-2 sm:mt-7 sm:flex sm:flex-wrap">
            <Button
              size="lg"
              className="h-11 px-3 text-sm sm:h-12 sm:px-6 sm:text-[15px]"
              onClick={() => openScanner('/scan/document')}
            >
              <ScanLine className="size-5" /> {messages.startScan}
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="h-11 px-3 text-sm sm:h-12 sm:px-6 sm:text-[15px]"
              onClick={() => document.getElementById('scan-modes')?.scrollIntoView()}
            >
              {messages.chooseScanType} <ArrowRight />
            </Button>
          </div>
          <div className="mt-5 flex flex-wrap gap-x-4 gap-y-2 text-xs font-medium text-muted-foreground sm:mt-7">
            <span className="flex items-center gap-1.5">
              <Check className="size-3.5 text-primary" /> {messages.noSignup}
            </span>
            <span className="flex items-center gap-1.5">
              <Check className="size-3.5 text-primary" /> {messages.worksOffline}
            </span>
            <span className="flex items-center gap-1.5">
              <Check className="size-3.5 text-primary" /> {messages.customWatermark}
            </span>
          </div>
        </div>

        <div className="relative mx-auto mt-10 hidden w-full max-w-lg sm:block lg:mt-0">
          <div className="relative rotate-1 rounded-3xl border border-border bg-card p-3 shadow-xl shadow-slate-900/10">
            <div className="paper-grid relative aspect-[4/3] overflow-hidden rounded-[1.4rem] p-7">
              <div className="absolute left-5 top-5 flex items-center gap-2 rounded-full bg-black/30 px-3 py-1.5 text-[10px] font-semibold text-white backdrop-blur">
                <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />{' '}
                {messages.edgesDetected}
              </div>
              <div className="mx-auto mt-7 flex h-[78%] w-[76%] rotate-[-2deg] flex-col rounded-sm bg-white p-6 shadow-2xl">
                <div className="flex items-center gap-3 border-b border-slate-200 pb-4">
                  <div className="size-9 shrink-0 rounded-full bg-secondary" />
                  <div className="space-y-2">
                    <div className="h-2 w-28 rounded bg-slate-300" />
                    <div className="h-1.5 w-20 rounded bg-slate-200" />
                  </div>
                </div>
                <div className="mt-5 grid flex-1 grid-cols-2 gap-3">
                  <div className="space-y-2">
                    {Array.from({ length: 6 }).map((_, index) => (
                      <div key={index} className="h-1.5 rounded bg-slate-200" />
                    ))}
                  </div>
                  <div className="rounded bg-muted" />
                </div>
              </div>
              <span className="absolute left-[10%] top-[18%] size-5 border-l-2 border-t-2 border-crop-guide" />
              <span className="absolute right-[9%] top-[16%] size-5 border-r-2 border-t-2 border-crop-guide" />
              <span className="absolute bottom-[9%] left-[12%] size-5 border-b-2 border-l-2 border-crop-guide" />
              <span className="absolute bottom-[10%] right-[10%] size-5 border-b-2 border-r-2 border-crop-guide" />
            </div>
            <div className="grid grid-cols-3 gap-2 px-1 pb-1 pt-4 text-center text-[10px] font-semibold text-muted-foreground">
              <span>
                <Sparkles className="mx-auto mb-1 size-4 text-primary" />
                {messages.autoEnhance}
              </span>
              <span>
                <FileStack className="mx-auto mb-1 size-4 text-primary" />
                {messages.multiPagePdf}
              </span>
              <span>
                <LockKeyhole className="mx-auto mb-1 size-4 text-primary" />
                {messages.localProcessing}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section id="scan-modes" className="scroll-mt-16 pt-10 sm:pt-16">
        <div className="mb-5 flex items-end justify-between gap-4 sm:mb-6">
          <div>
            <p className="text-xs font-bold uppercase tracking-[.18em] text-primary">Scan modes</p>
            <h2 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
              {messages.whatToScan}
            </h2>
          </div>
          <p className="hidden text-sm text-muted-foreground sm:block">{messages.scanTypesHint}</p>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {modes.map((mode) => (
            <button
              key={mode.mode}
              type="button"
              onClick={() => openScanner(`/scan/${mode.mode}`)}
              className="group min-w-0 rounded-2xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <Card className="flex h-full items-start gap-4 p-4 transition duration-200 group-hover:border-primary/30 group-hover:shadow-md md:block md:p-6">
                <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-secondary text-primary md:mb-5 md:size-14">
                  <mode.icon className="size-6 stroke-[1.5] md:size-7" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-base font-semibold md:text-lg">{mode.title}</h3>
                    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground transition group-hover:bg-primary group-hover:text-white">
                      <ArrowRight className="size-4" />
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground sm:text-sm md:mt-2">
                    {mode.description}
                  </p>
                  <p className="mt-1.5 hidden text-xs leading-5 text-muted-foreground md:block">
                    {mode.detail}
                  </p>
                </div>
              </Card>
            </button>
          ))}
        </div>
      </section>

      <section className="pt-10 sm:pt-16">
        <div className="mb-5 flex items-center justify-between sm:mb-6">
          <div>
            <p className="text-xs font-bold uppercase tracking-[.18em] text-primary">
              Recent scans
            </p>
            <h2 className="mt-2 text-2xl font-bold tracking-tight">{messages.recentScans}</h2>
          </div>
          {summaries.length > 0 && (
            <Button asChild variant="ghost">
              <Link to="/history">
                {messages.viewAll} <ArrowRight />
              </Link>
            </Button>
          )}
        </div>
        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="aspect-[4/3] animate-pulse rounded-2xl bg-muted" />
            ))}
          </div>
        ) : summaries.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {summaries.map((summary) => (
              <ProjectCard key={summary.project.id} summary={summary} />
            ))}
          </div>
        ) : (
          <Card className="flex flex-col items-center justify-center border-dashed px-6 py-12 text-center">
            <div className="grid size-12 place-items-center rounded-2xl bg-secondary text-primary">
              <FileStack />
            </div>
            <h3 className="mt-4 font-semibold">{messages.noHistory}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{messages.recentEmpty}</p>
          </Card>
        )}
      </section>

      <section className="mt-10 grid gap-4 rounded-2xl border border-border bg-card p-6 sm:mt-14 sm:grid-cols-3 sm:p-8">
        <div className="flex gap-3">
          <LockKeyhole className="mt-0.5 size-5 shrink-0 text-primary" />
          <div>
            <h3 className="text-sm font-bold">{messages.noUpload}</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {messages.noUploadDescription}
            </p>
          </div>
        </div>
        <div className="flex gap-3">
          <WifiOff className="mt-0.5 size-5 shrink-0 text-primary" />
          <div>
            <h3 className="text-sm font-bold">{messages.offlineAfterSetup}</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {messages.offlineAfterSetupDescription}
            </p>
          </div>
        </div>
        <div className="flex gap-3">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" />
          <div>
            <h3 className="text-sm font-bold">{messages.clearAnytime}</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {messages.clearAnytimeDescription}
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}
