import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_QUAD } from './geometry'
import { ScannerClient, createRenderCacheKey, isAbortError } from './scanner-client'
import {
  DEFAULT_ADJUSTMENTS,
  SMART_EFFECTS,
  type ScanPage,
  type ScannerWorkerRequest,
} from './types'

class WorkerMock extends EventTarget {
  static instances: WorkerMock[] = []
  messages: ScannerWorkerRequest[] = []
  terminated = false

  constructor() {
    super()
    WorkerMock.instances.push(this)
  }

  postMessage(message: ScannerWorkerRequest) {
    this.messages.push(message)
  }

  terminate() {
    this.terminated = true
  }

  respond(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }
}

function makePage(adjustment = 0): ScanPage {
  return {
    id: 'page-1',
    projectId: 'project-1',
    order: 0,
    role: 'page',
    source: new Blob(['source'], { type: 'image/jpeg' }),
    sourceName: 'source.jpg',
    width: 1200,
    height: 900,
    corners: DEFAULT_QUAD,
    confidence: 0.9,
    cornerSource: 'detected',
    cropConfirmed: true,
    glareLevel: 'none',
    rotation: 0,
    effects: { ...SMART_EFFECTS },
    adjustments: { ...DEFAULT_ADJUSTMENTS, brightness: adjustment },
    createdAt: 1,
    updatedAt: 1 + adjustment,
  }
}

beforeEach(() => {
  WorkerMock.instances = []
  vi.stubGlobal('Worker', WorkerMock)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:scanner-worker')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('scanner request scheduling', () => {
  it('keeps only the newest queued preview', async () => {
    const client = new ScannerClient()
    const options = { maxEdge: 1400, mimeType: 'image/jpeg' as const, quality: 0.9 }
    const first = client.render(makePage(0), options, { intent: 'preview' })
    const second = client.render(makePage(1), options, { intent: 'preview' })
    const secondRejected = second.catch((error: unknown) => error)
    const third = client.render(makePage(2), options, { intent: 'preview' })
    const worker = WorkerMock.instances[0]

    expect(worker.messages).toHaveLength(1)
    expect(worker.messages[0].type).toBe('render')
    expect(isAbortError(await secondRejected)).toBe(true)

    worker.respond({
      id: worker.messages[0].id,
      type: 'rendered',
      blob: new Blob(['first']),
      width: 100,
      height: 80,
    })
    await first
    expect(worker.messages).toHaveLength(2)
    expect(worker.messages[1]).toMatchObject({
      type: 'render',
      page: { adjustments: { brightness: 2 } },
    })

    worker.respond({
      id: worker.messages[1].id,
      type: 'rendered',
      blob: new Blob(['third']),
      width: 100,
      height: 80,
    })
    await third
  })

  it('prewarms once and reuses an identical export render', async () => {
    const client = new ScannerClient()
    const warming = client.prewarm()
    const worker = WorkerMock.instances[0]
    expect(worker.messages[0].type).toBe('init')
    worker.respond({ id: worker.messages[0].id, type: 'ready' })
    await warming
    await client.prewarm()
    expect(worker.messages).toHaveLength(1)

    const page = makePage()
    const options = { maxEdge: 3000, mimeType: 'image/jpeg' as const, quality: 0.94 }
    const first = client.render(page, options, { intent: 'export' })
    expect(worker.messages).toHaveLength(2)
    worker.respond({
      id: worker.messages[1].id,
      type: 'rendered',
      blob: new Blob(['export']),
      width: 3000,
      height: 2250,
    })
    const rendered = await first
    const cached = await client.render(page, options, { intent: 'export' })

    expect(worker.messages).toHaveLength(2)
    expect(cached).toEqual(rendered)
  })
})

describe('render cache keys', () => {
  it('ignores autosave timestamps but changes with pixels or output options', () => {
    const options = { maxEdge: 3000, mimeType: 'image/jpeg' as const, quality: 0.94 }
    const original = makePage()
    expect(createRenderCacheKey({ ...original, updatedAt: 99 }, options)).toBe(
      createRenderCacheKey(original, options),
    )
    expect(createRenderCacheKey(makePage(1), options)).not.toBe(
      createRenderCacheKey(original, options),
    )
    expect(
      createRenderCacheKey(
        {
          ...original,
          adjustments: { ...original.adjustments, whiteningStrength: 40 },
        },
        options,
      ),
    ).not.toBe(createRenderCacheKey(original, options))
    expect(createRenderCacheKey(original, { ...options, maxEdge: 2999 })).not.toBe(
      createRenderCacheKey(original, options),
    )
  })
})
