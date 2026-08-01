import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const expectedBytes = 62_045_318
const expectedHash = '9728294ad65fa2d68c9c7b61fc8580555865d2dbdbbf46c326005283b2d44cc2'
const source = process.argv[2] ?? '/tmp/docshadow_sd7k_fp16.onnx'
const destination = path.resolve('public/models/docshadow-sd7k-fp16-v1.onnx')

const metadata = await stat(source).catch(() => undefined)
if (!metadata || metadata.size !== expectedBytes) {
  throw new Error(`Expected the verified ${expectedBytes}-byte FP16 model at ${source}`)
}
const digest = createHash('sha256').update(await readFile(source)).digest('hex')
if (digest !== expectedHash) throw new Error(`Model checksum mismatch: ${digest}`)
await mkdir(path.dirname(destination), { recursive: true })
await copyFile(source, destination)
console.log(`Prepared ${destination} (${expectedBytes} bytes, sha256 ${digest})`)
