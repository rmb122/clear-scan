import { create } from 'zustand'

interface AppStore {
  engineReady: boolean
  engineProgress: number
  engineLabel: string
  setEngineState: (ready: boolean, progress: number, label?: string) => void
}

export const useAppStore = create<AppStore>((set) => ({
  engineReady: false,
  engineProgress: 0,
  engineLabel: '正在准备本地图像引擎',
  setEngineState: (engineReady, engineProgress, engineLabel) =>
    set((state) => ({
      engineReady,
      engineProgress,
      engineLabel: engineLabel ?? state.engineLabel,
    })),
}))
