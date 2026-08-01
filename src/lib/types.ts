export type ScanMode = 'id-card' | 'passport' | 'document'

export type PassportLayout = 'data-page' | 'spread'

export type PageRole = 'front' | 'back' | 'page'

export type FilterPreset =
  | 'original'
  | 'smart'
  | 'deshadow'
  | 'ai-deshadow'
  | 'deglare'
  | 'grayscale'
  | 'black-white'
  | 'sharpen'
  | 'vivid'

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

export type AdvancedModelBackend = 'wasm' | 'webgpu'

export interface AdvancedCorrection {
  fingerprint: string
  modelId: string
  modelVersion: string
  /** RGB gain field. A value of 128 represents a neutral 1x gain. */
  map: Blob
  width: number
  height: number
  backend: AdvancedModelBackend
  inferenceMs: number
  createdAt: number
}

export type AdvancedModelInstallState =
  | 'not-installed'
  | 'installing'
  | 'ready'
  | 'error'

export interface AdvancedModelRecord {
  id: string
  version: string
  state: Exclude<AdvancedModelInstallState, 'not-installed'>
  expectedBytes: number
  downloadedBytes: number
  sha256: string
  installedAt?: number
  error?: string
  backend?: AdvancedModelBackend
  benchmarkMs?: number
  inputSize?: 256 | 384 | 512
}

export interface AdvancedModelChunk {
  modelId: string
  index: number
  data: ArrayBuffer
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
  filter: FilterPreset
  adjustments: EnhancementSettings
  advancedCorrection?: AdvancedCorrection
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

export interface WorkerRequestBase {
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
  | (WorkerRequestBase & {
      type: 'prepare-model'
      model: ArrayBuffer
      preferWebGpu: boolean
    })
  | (WorkerRequestBase & {
      type: 'release-model'
    })

export type ScannerWorkerResponse =
  | { id: string; type: 'ready' }
  | { id: string; type: 'progress'; progress: number; label: string }
  | { id: string; type: 'detected'; result: DetectionResult }
  | {
      id: string
      type: 'rendered'
      blob: Blob
      width: number
      height: number
      correction?: AdvancedCorrection
    }
  | {
      id: string
      type: 'model-ready'
      backend: AdvancedModelBackend
      benchmarkMs: number
      inputSize: 256 | 384 | 512
    }
  | { id: string; type: 'model-released' }
  | { id: string; type: 'error'; message: string }

export const DEFAULT_ADJUSTMENTS: EnhancementSettings = {
  brightness: 0,
  contrast: 0,
  sharpness: 0,
  shadowStrength: 50,
}

export const MODE_LABELS: Record<ScanMode, string> = {
  'id-card': '身份证扫描',
  passport: '护照扫描',
  document: '文档扫描',
}

export const FILTER_LABELS: Record<FilterPreset, string> = {
  original: '原版',
  smart: '智能增强',
  deshadow: '去阴影',
  'ai-deshadow': 'AI 去阴影',
  deglare: '去反光',
  grayscale: '灰度',
  'black-white': '黑白',
  sharpen: '加锐',
  vivid: '鲜艳',
}
