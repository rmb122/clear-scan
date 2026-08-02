import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_QUAD } from './geometry'
import { DEFAULT_ADJUSTMENTS, SMART_EFFECTS, type ScanPage, type ScanProject } from './types'

const { renderMock } = vi.hoisted(() => ({
  renderMock: vi.fn(),
}))

vi.mock('./scanner-client', () => ({
  scannerClient: { render: renderMock },
}))

import { exportProject } from './exporters'

function makePage(id: string, order: number): ScanPage {
  return {
    id,
    projectId: 'project-1',
    order,
    role: 'page',
    source: new Blob([id], { type: 'image/jpeg' }),
    sourceName: `${id}.jpg`,
    width: 1200,
    height: 900,
    corners: DEFAULT_QUAD,
    confidence: 0.9,
    cornerSource: 'detected',
    cropConfirmed: true,
    glareLevel: 'none',
    rotation: 0,
    effects: { ...SMART_EFFECTS },
    adjustments: { ...DEFAULT_ADJUSTMENTS },
    createdAt: order,
    updatedAt: order,
  }
}

describe('image package export', () => {
  it('keeps full render settings and stores already-compressed JPEG entries', async () => {
    renderMock.mockReset()
    renderMock.mockResolvedValue({
      blob: new Blob(['jpeg-data'], { type: 'image/jpeg' }),
      width: 3000,
      height: 2250,
    })
    const project: ScanProject = {
      id: 'project-1',
      name: '测试文档',
      mode: 'document',
      createdAt: 1,
      updatedAt: 1,
    }

    const result = await exportProject(project, [makePage('page-2', 1), makePage('page-1', 0)], 'zip', 'content')

    expect(renderMock).toHaveBeenCalledTimes(2)
    expect(renderMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 'page-1' }),
      { maxEdge: 3000, mimeType: 'image/jpeg', quality: 0.94 },
      { intent: 'export' },
    )
    const bytes = new DataView(await result.blob.arrayBuffer())
    expect(bytes.getUint32(0, true)).toBe(0x04034b50)
    expect(bytes.getUint16(8, true)).toBe(0)
    expect(result.fileName).toBe('测试文档-图片包.zip')
  })
})
