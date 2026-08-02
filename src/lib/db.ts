import Dexie, { type EntityTable } from 'dexie'
import { DEFAULT_ADJUSTMENTS, type ScanPage, type ScanProject } from './types'

interface StoredBinary {
  data: ArrayBuffer
  type: string
}

type StoredScanPage = Omit<ScanPage, 'source' | 'thumbnail'> & {
  source: StoredBinary
  thumbnail?: StoredBinary
}

class ScannerDatabase extends Dexie {
  projects!: EntityTable<ScanProject, 'id'>
  pages!: EntityTable<StoredScanPage, 'id'>

  constructor() {
    super('clear-scan-db')
    this.version(3).stores({
      projects: 'id, mode, createdAt, updatedAt',
      pages: 'id, projectId, [projectId+order], role, updatedAt',
    })
  }
}

export const db = new ScannerDatabase()

async function encodeBinary(blob: Blob): Promise<StoredBinary> {
  return {
    data: await blob.arrayBuffer(),
    type: blob.type || 'application/octet-stream',
  }
}

function decodeBinary(binary: StoredBinary) {
  return new Blob([binary.data], { type: binary.type })
}

async function encodePage(page: ScanPage): Promise<StoredScanPage> {
  const { source, thumbnail, ...metadata } = page
  return {
    ...metadata,
    source: await encodeBinary(source),
    thumbnail: thumbnail ? await encodeBinary(thumbnail) : undefined,
  }
}

function decodePage(page: StoredScanPage): ScanPage {
  const { source, thumbnail, adjustments, ...metadata } = page
  return {
    ...metadata,
    source: decodeBinary(source),
    thumbnail: thumbnail ? decodeBinary(thumbnail) : undefined,
    adjustments: {
      ...DEFAULT_ADJUSTMENTS,
      ...adjustments,
    },
  }
}

export async function putPage(page: ScanPage) {
  return db.pages.put(await encodePage(page))
}

export async function bulkPutPages(pages: ScanPage[]) {
  const storedPages = await Promise.all(pages.map(encodePage))
  return db.pages.bulkPut(storedPages)
}

export async function getProjectPages(projectId: string) {
  const pages = await db.pages.where('projectId').equals(projectId).sortBy('order')
  return pages.map(decodePage)
}

export async function getProjectWithPages(projectId: string) {
  const [project, pages] = await Promise.all([db.projects.get(projectId), getProjectPages(projectId)])
  return { project, pages }
}

export async function deleteProject(projectId: string) {
  await db.transaction('rw', db.projects, db.pages, async () => {
    await db.pages.where('projectId').equals(projectId).delete()
    await db.projects.delete(projectId)
  })
}

export async function clearScannerData() {
  await db.transaction('rw', db.projects, db.pages, async () => {
    await db.pages.clear()
    await db.projects.clear()
  })
}
