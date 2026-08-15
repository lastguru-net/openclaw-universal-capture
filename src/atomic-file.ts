import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"

const fileQueues = new Map<string, Promise<void>>()
const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set([
  "EACCES",
  "EISDIR",
  "EINVAL",
  "ENOTSUP",
  "EPERM",
])

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined
}

async function syncParentDirectory(filePath: string): Promise<void> {
  try {
    const directoryHandle = await open(dirname(filePath), "r")
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } catch (error) {
    const code = errorCode(error)
    if (!code || !UNSUPPORTED_DIRECTORY_SYNC_CODES.has(code)) throw error
  }
}

export async function withFileLock<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = fileQueues.get(filePath) ?? Promise.resolve()
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate
  })
  const queued = previous.catch(() => undefined).then(() => gate)
  fileQueues.set(filePath, queued)

  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release?.()
    if (fileQueues.get(filePath) === queued) fileQueues.delete(filePath)
  }
}

export async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8")
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined
    }
    throw error
  }
}

export async function atomicWriteText(filePath: string, text: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmpPath = resolve(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(tmpPath, "wx")
    await handle.writeFile(text, "utf8")
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(tmpPath, filePath)
    await syncParentDirectory(filePath)
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(tmpPath, { force: true }).catch(() => undefined)
  }
}
