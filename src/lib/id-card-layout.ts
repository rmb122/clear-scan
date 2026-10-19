export type IdCardSize = 'enlarged' | 'original'

export const A4_MM = { width: 210, height: 297 }
const ID_CARD_MM = { width: 85.6, height: 53.98 }
const ID_CARD_ASPECT_RATIO = ID_CARD_MM.width / ID_CARD_MM.height
const CARD_WIDTH_RATIO = 0.8
const CONTENT_HEIGHT_RATIO = 0.8
const GAP_HEIGHT_RATIO = 0.05

interface Rectangle {
  x: number
  y: number
  width: number
  height: number
}

export interface IdCardSheetLayout {
  front: Rectangle
  back: Rectangle
}

export function getIdCardSheetLayout(
  canvasWidth: number,
  canvasHeight: number,
  size: IdCardSize,
): IdCardSheetLayout {
  const gap = Math.round(canvasHeight * GAP_HEIGHT_RATIO)
  const maxCardHeight = (canvasHeight * CONTENT_HEIGHT_RATIO - gap) / 2
  // The sheet represents A4. Keep fractional pixels for physical-size placement.
  const cardWidth =
    size === 'original'
      ? (canvasWidth * ID_CARD_MM.width) / A4_MM.width
      : Math.round(Math.min(canvasWidth * CARD_WIDTH_RATIO, maxCardHeight * ID_CARD_ASPECT_RATIO))
  const cardHeight =
    size === 'original'
      ? (canvasHeight * ID_CARD_MM.height) / A4_MM.height
      : Math.round(cardWidth / ID_CARD_ASPECT_RATIO)
  const x = (canvasWidth - cardWidth) / 2
  const frontY = (canvasHeight - cardHeight * 2 - gap) / 2

  return {
    front: { x, y: frontY, width: cardWidth, height: cardHeight },
    back: { x, y: frontY + cardHeight + gap, width: cardWidth, height: cardHeight },
  }
}
