import { useAppStore } from '@/store/app-store'
import scannerWorkerUrl from '../workers/scanner.worker.ts?worker&url'
import type {
  DetectionResult,
  PassportLayout,
  RenderOptions,
  ScanMode,
  ScanPage,
  ScannerWorkerRequest,
  ScannerWorkerResponse,
} from './types'
import { createId } from './utils'

interface PendingRequest {
  resolve: (response: ScannerWorkerResponse) => void
  reject: (error: Error) => void
  timeout: number
}

class ScannerClient {
  private worker: Worker | undefined
  private pending = new Map<string, PendingRequest>()

  private getWorker() {
    if (this.worker) return this.worker
    const openCvUrl = new URL(`${import.meta.env.BASE_URL}vendor/opencv.js`, window.location.origin).href
    const moduleUrl = new URL(scannerWorkerUrl, window.location.origin).href
    const bootstrap = `
      const queuedMessages=[];
      const holdMessage=(event)=>queuedMessages.push(event.data);
      self.addEventListener('message',holdMessage);
      importScripts(${JSON.stringify(openCvUrl)});
      self.postMessage({id:'__bootstrap__',type:'progress',progress:3,label:'OpenCV 脚本已载入'});
      import(${JSON.stringify(moduleUrl)}).then(()=>{
        self.postMessage({id:'__bootstrap__',type:'progress',progress:6,label:'图像 Worker 已启动'});
        self.removeEventListener('message',holdMessage);
        queuedMessages.forEach((data)=>self.dispatchEvent(new MessageEvent('message',{data})));
      }).catch((error)=>setTimeout(()=>{throw error}));
    `
    const bootstrapUrl = URL.createObjectURL(new Blob([bootstrap], { type: 'text/javascript' }))
    this.worker = new Worker(bootstrapUrl)
    window.setTimeout(() => URL.revokeObjectURL(bootstrapUrl), 10_000)
    this.worker.addEventListener('message', (event: MessageEvent<ScannerWorkerResponse>) => {
      const response = event.data
      if (response.type === 'progress') {
        useAppStore.getState().setEngineState(response.progress, response.label)
        return
      }
      const request = this.pending.get(response.id)
      if (!request) return
      if (response.type === 'error') {
        window.clearTimeout(request.timeout)
        this.pending.delete(response.id)
        useAppStore.getState().setEngineState(100, '标准图像引擎可用')
        request.reject(new Error(response.message))
        return
      }
      if (response.type === 'detected' || response.type === 'rendered') {
        window.clearTimeout(request.timeout)
        this.pending.delete(response.id)
        useAppStore.getState().setEngineState(100, '本地图像引擎已就绪')
        request.resolve(response)
      }
    })
    this.worker.addEventListener('error', (event) => {
      const error = new Error(event.message || '图像处理 Worker 无法启动')
      this.pending.forEach((request) => request.reject(error))
      this.pending.clear()
      this.worker?.terminate()
      this.worker = undefined
    })
    return this.worker
  }

  private request(message: ScannerWorkerRequest, timeoutMs = 90_000) {
    return new Promise<ScannerWorkerResponse>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(message.id)
        reject(new Error('图像处理超时，请尝试尺寸更小的照片'))
      }, timeoutMs)
      this.pending.set(message.id, { resolve, reject, timeout })
      this.getWorker().postMessage(message)
    })
  }

  async detect(source: Blob, mode: ScanMode, passportLayout?: PassportLayout) {
    const response = await this.request({
      id: createId(),
      type: 'detect',
      source,
      mode,
      passportLayout,
    })
    if (response.type !== 'detected') throw new Error('未收到边缘识别结果')
    return response.result as DetectionResult
  }

  async render(page: ScanPage, options: RenderOptions) {
    const response = await this.request({
      id: createId(),
      type: 'render',
      page,
      options,
    })
    if (response.type !== 'rendered') throw new Error('未收到图像处理结果')
    return {
      blob: response.blob,
      width: response.width,
      height: response.height,
    }
  }
}

export const scannerClient = new ScannerClient()
