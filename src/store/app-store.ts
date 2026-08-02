import { create } from 'zustand'

interface AppStore {
  engineProgress: number
  engineLabel: string
  setEngineState: (progress: number, label?: string) => void
}

export const useAppStore = create<AppStore>((set) => ({
  engineProgress: 0,
  engineLabel: '正在准备本地图像引擎',
  setEngineState: (engineProgress, engineLabel) =>
    set((state) => ({
      engineProgress,
      engineLabel: engineLabel ?? state.engineLabel,
    })),
}))
