import type { Locale } from './i18n'

export type ScanMode = 'id-card' | 'passport' | 'document'

export type PassportLayout = 'data-page' | 'spread'

export type PageRole = 'front' | 'back' | 'page'

type ShadowEffect = 'none' | 'deshadow' | 'balance'

type GlareEffect = 'none' | 'deglare'

type ColorEffect = 'original' | 'enhanced-color' | 'grayscale' | 'black-white'

type DetailEffect = 'none' | 'sharpen'

export type EnhancementEffect = ShadowEffect | GlareEffect | ColorEffect | DetailEffect

export interface EnhancementEffects {
  shadow: ShadowEffect
  glare: GlareEffect
  color: ColorEffect
  detail: DetailEffect
}

export type GlareLevel = 'none' | 'mild' | 'severe'

export type CornerSource = 'detected' | 'manual' | 'fallback'

export interface Point {
  x: number
  y: number
}

export type NormalizedQuad = [Point, Point, Point, Point]

export const DEFAULT_WHITENING_STRENGTH = 88

export interface EnhancementSettings {
  brightness: number
  contrast: number
  sharpness: number
  shadowStrength: number
  whiteningStrength: number
}

export interface WatermarkSettings {
  enabled: boolean
  text: string
  fontSize: number
  opacity: number
  color: string
  angle: number
  spacing: number
}

export const DEFAULT_WATERMARK: WatermarkSettings = {
  enabled: false,
  text: '',
  fontSize: 36,
  opacity: 25,
  color: '#808080',
  angle: -30,
  spacing: 80,
}

export interface ScanProject {
  id: string
  name: string
  mode: ScanMode
  passportLayout?: PassportLayout
  watermark?: WatermarkSettings
  createdAt: number
  updatedAt: number
}

export interface ScanPage {
  id: string
  projectId: string
  order: number
  role: PageRole
  source: Blob
  sourceName: string
  width: number
  height: number
  corners: NormalizedQuad
  confidence: number
  cornerSource: CornerSource
  cropConfirmed: boolean
  glareLevel: GlareLevel
  rotation: 0 | 90 | 180 | 270
  effects: EnhancementEffects
  adjustments: EnhancementSettings
  thumbnail?: Blob
  createdAt: number
  updatedAt: number
}

export interface DetectionResult {
  width: number
  height: number
  corners: NormalizedQuad
  confidence: number
  cornerSource: CornerSource
  glareLevel: GlareLevel
}

export interface RenderOptions {
  maxEdge: number
  mimeType: 'image/jpeg' | 'image/png'
  quality?: number
  watermark?: WatermarkSettings
}

interface WorkerRequestBase {
  id: string
  locale: Locale
}

export type ScannerWorkerRequest =
  | (WorkerRequestBase & {
      type: 'init'
    })
  | (WorkerRequestBase & {
      type: 'invalidate-cache'
      pageId: string
    })
  | (WorkerRequestBase & {
      type: 'detect'
      source: Blob
      mode: ScanMode
      passportLayout?: PassportLayout
    })
  | (WorkerRequestBase & {
      type: 'render'
      page: ScanPage
      options: RenderOptions
      cacheIntermediate: boolean
    })

export type ScannerWorkerResponse =
  | { id: string; type: 'progress'; progress: number; label: string }
  | { id: string; type: 'ready' }
  | { id: string; type: 'detected'; result: DetectionResult }
  | {
      id: string
      type: 'rendered'
      blob: Blob
      width: number
      height: number
    }
  | { id: string; type: 'error'; message: string }

export const DEFAULT_ADJUSTMENTS: EnhancementSettings = {
  brightness: 0,
  contrast: 0,
  sharpness: 50,
  shadowStrength: 80,
  whiteningStrength: DEFAULT_WHITENING_STRENGTH,
}

export const ORIGINAL_EFFECTS: EnhancementEffects = {
  shadow: 'none',
  glare: 'none',
  color: 'original',
  detail: 'none',
}

export const SMART_EFFECTS: EnhancementEffects = {
  shadow: 'balance',
  glare: 'deglare',
  color: 'enhanced-color',
  detail: 'sharpen',
}
