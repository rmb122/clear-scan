import { create } from 'zustand'
import type { AdvancedModelInstallState, AdvancedModelRecord } from '@/lib/types'

interface AppStore {
  engineReady: boolean
  engineProgress: number
  engineLabel: string
  modelState: AdvancedModelInstallState
  modelProgress: number
  modelLabel: string
  modelRecord?: AdvancedModelRecord
  setEngineState: (ready: boolean, progress: number, label?: string) => void
  setModelState: (
    state: AdvancedModelInstallState,
    progress?: number,
    label?: string,
    record?: AdvancedModelRecord,
  ) => void
}

export const useAppStore = create<AppStore>((set) => ({
  engineReady: false,
  engineProgress: 0,
  engineLabel: '正在准备本地图像引擎',
  modelState: 'not-installed',
  modelProgress: 0,
  modelLabel: '高级去阴影尚未安装',
  setEngineState: (engineReady, engineProgress, engineLabel) =>
    set((state) => ({
      engineReady,
      engineProgress,
      engineLabel: engineLabel ?? state.engineLabel,
    })),
  setModelState: (modelState, modelProgress = 0, modelLabel, modelRecord) =>
    set((state) => ({
      modelState,
      modelProgress,
      modelLabel: modelLabel ?? state.modelLabel,
      modelRecord,
    })),
}))
