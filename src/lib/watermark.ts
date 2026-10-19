import type { WatermarkSettings } from './types'

interface ContentBounds {
  x: number
  y: number
  width: number
  height: number
}

export function hasWatermark(settings?: WatermarkSettings): settings is WatermarkSettings {
  return Boolean(settings?.enabled && settings.text.trim())
}

export function drawWatermark(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  content: ContentBounds,
  settings?: WatermarkSettings,
) {
  if (!hasWatermark(settings)) return

  const shortEdge = Math.min(content.width, content.height)
  const padding = shortEdge * 0.1
  const left = Math.max(0, content.x - padding)
  const top = Math.max(0, content.y - padding)
  const right = Math.min(context.canvas.width, content.x + content.width + padding)
  const bottom = Math.min(context.canvas.height, content.y + content.height + padding)
  if (shortEdge <= 0 || right <= left || bottom <= top) return

  const scale = shortEdge / 1000
  const fontSize = settings.fontSize * scale
  const spacing = settings.spacing * scale
  const text = settings.text.trim()

  context.save()
  try {
    context.beginPath()
    context.rect(left, top, right - left, bottom - top)
    context.clip()
    context.translate(content.x + content.width / 2, content.y + content.height / 2)
    context.rotate((settings.angle * Math.PI) / 180)
    context.font = `${fontSize}px "SF Pro Display", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillStyle = settings.color
    context.globalAlpha = settings.opacity / 100

    const textWidth = context.measureText(text).width
    const stepX = textWidth + spacing
    const stepY = fontSize + spacing
    // The expanded rectangle fits inside this radius at every rotation.
    // Anchor the grid to the content, so A4 whitespace does not move the text.
    const radius = Math.hypot(content.width / 2 + padding, content.height / 2 + padding)
    const columns = Math.ceil((radius + textWidth / 2) / stepX)
    const rows = Math.ceil((radius + fontSize) / stepY)
    for (let row = -rows; row <= rows; row += 1) {
      for (let column = -columns; column <= columns; column += 1) {
        context.fillText(text, column * stepX, row * stepY)
      }
    }
  } finally {
    context.restore()
  }
}
