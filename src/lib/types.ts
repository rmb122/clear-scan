export type ScanMode = 'id-card' | 'passport' | 'document'

export type PassportLayout = 'data-page' | 'spread'

export type PageRole = 'front' | 'back' | 'page'

type ShadowEffect = 'none' | 'deshadow'

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

export interface Point {
  x: number
  y: number
}

export type NormalizedQuad = [Point, Point, Point, Point]

export interface EnhancementSettings {
  brightness: number
  contrast: number
  sharpness: number
  shadowStrength: number
}

export interface ScanProject {
  id: string
  name: string
  mode: ScanMode
  passportLayout?: PassportLayout
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
  glareLevel: GlareLevel
}

export interface RenderOptions {
  maxEdge: number
  mimeType: 'image/jpeg' | 'image/png'
  quality?: number
}

interface WorkerRequestBase {
  id: string
}

export type ScannerWorkerRequest =
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
    })

export type ScannerWorkerResponse =
  | { id: string; type: 'progress'; progress: number; label: string }
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
  shadowStrength: 50,
}

export const ORIGINAL_EFFECTS: EnhancementEffects = {
  shadow: 'none',
  glare: 'none',
  color: 'original',
  detail: 'none',
}

export const SMART_EFFECTS: EnhancementEffects = {
  shadow: 'deshadow',
  glare: 'deglare',
  color: 'enhanced-color',
  detail: 'sharpen',
}

export const MODE_LABELS: Record<ScanMode, string> = {
  'id-card': '身份证扫描',
  passport: '护照扫描',
  document: '文档扫描',
}
