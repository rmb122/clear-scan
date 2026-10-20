import type { CV } from '@techstark/opencv-js'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_QUAD } from '@/lib/geometry'
import { messages } from '@/lib/i18n'
import { renderPage } from '@/workers/page-renderer'
import { blobToImageData } from '@/workers/worker-image-utils'
import { makePage } from '../../support/scan-fixtures'

vi.mock('@/workers/worker-image-utils', () => ({
  blobToImageData: vi.fn(),
}))

describe('page rendering', () => {
  it('rejects crossed corners before decoding the image instead of silently reordering them', async () => {
    const page = makePage({
      corners: [DEFAULT_QUAD[0], DEFAULT_QUAD[2], DEFAULT_QUAD[1], DEFAULT_QUAD[3]],
    })

    await expect(
      renderPage({} as CV, page, { maxEdge: 1600, mimeType: 'image/jpeg' }),
    ).rejects.toThrow(messages.invalidCropCorners)
    expect(blobToImageData).not.toHaveBeenCalled()
  })
})
