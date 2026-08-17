const ID_CARD_ASPECT_RATIO = 85.6 / 53.98
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

export function getIdCardSheetLayout(canvasWidth: number, canvasHeight: number): IdCardSheetLayout {
  const gap = Math.round(canvasHeight * GAP_HEIGHT_RATIO)
  const maxCardHeight = (canvasHeight * CONTENT_HEIGHT_RATIO - gap) / 2
  const cardWidth = Math.round(
    Math.min(canvasWidth * CARD_WIDTH_RATIO, maxCardHeight * ID_CARD_ASPECT_RATIO),
  )
  const cardHeight = Math.round(cardWidth / ID_CARD_ASPECT_RATIO)
  const x = Math.round((canvasWidth - cardWidth) / 2)
  const frontY = Math.round((canvasHeight - cardHeight * 2 - gap) / 2)

  return {
    front: { x, y: frontY, width: cardWidth, height: cardHeight },
    back: { x, y: frontY + cardHeight + gap, width: cardWidth, height: cardHeight },
  }
}
