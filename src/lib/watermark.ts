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
  contentRegions: ContentBounds[] = [content],
) {
  if (!hasWatermark(settings)) return

  const shortEdge = Math.min(content.width, content.height)
  if (shortEdge <= 0) return
  const centerX = content.x + content.width / 2
  const centerY = content.y + content.height / 2

  const scale = shortEdge / 1000
  const fontSize = settings.fontSize * scale
  const spacing = settings.spacing * scale
  const text = settings.text.trim()

  context.save()
  try {
    context.beginPath()
    let radius = 0
    for (const region of contentRegions) {
      const padding = Math.min(region.width, region.height) * 0.1
      const left = Math.max(0, region.x - padding)
      const top = Math.max(0, region.y - padding)
      const right = Math.min(context.canvas.width, region.x + region.width + padding)
      const bottom = Math.min(context.canvas.height, region.y + region.height + padding)
      if (right <= left || bottom <= top) continue
      context.rect(left, top, right - left, bottom - top)
      radius = Math.max(
        radius,
        Math.hypot(
          Math.max(Math.abs(left - centerX), Math.abs(right - centerX)),
          Math.max(Math.abs(top - centerY), Math.abs(bottom - centerY)),
        ),
      )
    }
    if (radius === 0) return
    // Union the regions in one clip so overlaps receive just one layer of text.
    context.clip()
    context.translate(centerX, centerY)
    context.rotate((settings.angle * Math.PI) / 180)
    context.font = `${fontSize}px "SF Pro Display", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillStyle = settings.color
    context.globalAlpha = settings.opacity / 100

    const textWidth = context.measureText(text).width
    const stepX = textWidth + spacing
    const stepY = fontSize + spacing
    // Cover all clipped regions with one grid anchored to the reference content.
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
