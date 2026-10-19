import Dexie from 'dexie'
import { vi } from 'vitest'
import { db } from '@/lib/db'

function writeGate() {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  return { pending, release }
}

export function holdNextPageWrite() {
  const { pending, release } = writeGate()
  const update = db.pages.update.bind(db.pages)
  const writes = vi
    .spyOn(db.pages, 'update')
    .mockImplementationOnce((...args) => Dexie.Promise.resolve(pending).then(() => update(...args)))
  return { release, writes }
}

export function holdNextProjectWrite() {
  const { pending, release } = writeGate()
  const update = db.projects.update.bind(db.projects)
  const writes = vi
    .spyOn(db.projects, 'update')
    .mockImplementationOnce((...args) => Dexie.Promise.resolve(pending).then(() => update(...args)))
  return { release, writes }
}

export function holdThumbnailEncoding() {
  const { pending, release } = writeGate()
  const blob = new Blob(['thumbnail'], { type: 'image/png' })
  const read = blob.arrayBuffer.bind(blob)
  const encoding = vi.spyOn(blob, 'arrayBuffer').mockImplementationOnce(async () => {
    await pending
    return read()
  })
  return { blob, release, encoding }
}
