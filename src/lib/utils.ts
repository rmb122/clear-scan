import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

let idCounter = 0

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function createId() {
  idCounter = (idCounter + 1) % 0x100000
  let entropy: string | undefined
  const cryptoApi = globalThis.crypto as Crypto | undefined

  if (typeof cryptoApi?.getRandomValues === 'function') {
    try {
      const values = cryptoApi.getRandomValues(new Uint32Array(3))
      entropy = Array.from(values, (value) => value.toString(36)).join('')
    } catch {
      entropy = undefined
    }
  }

  if (!entropy) {
    entropy = `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}` || '0'
  }

  return `${Date.now().toString(36)}-${idCounter.toString(36)}-${entropy}`
}

export function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}

export function sanitizeFileName(value: string) {
  const cleaned = value
    .trim()
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
  return cleaned || '清晰扫描'
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

export function modeDefaultName(mode: string) {
  const date = new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
  }).format(Date.now())
  const prefix = mode === 'id-card' ? '身份证' : mode === 'passport' ? '护照' : '扫描文档'
  return `${prefix} ${date}`
}
