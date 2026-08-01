import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'

class ResizeObserverMock implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverMock
