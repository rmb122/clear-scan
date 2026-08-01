import { afterEach, describe, expect, it, vi } from 'vitest'
import { createId, modeDefaultName, sanitizeFileName } from './utils'

afterEach(() => vi.unstubAllGlobals())

describe('local identifiers', () => {
  it('stays unique when Web Crypto is unavailable', () => {
    vi.stubGlobal('crypto', undefined)
    const first = createId()
    const second = createId()

    expect(first).not.toBe(second)
    expect(first).toMatch(/^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/)
  })
})

describe('export naming', () => {
  it('removes unsafe file-system characters', () => {
    expect(sanitizeFileName('  护照 / 张三:*?  ')).toBe('护照 - 张三---')
  })

  it('uses a safe fallback for empty names', () => {
    expect(sanitizeFileName('   ')).toBe('清晰扫描')
  })

  it('creates mode-specific default names', () => {
    expect(modeDefaultName('id-card')).toMatch(/^身份证 /)
    expect(modeDefaultName('passport')).toMatch(/^护照 /)
    expect(modeDefaultName('document')).toMatch(/^扫描文档 /)
  })
})
