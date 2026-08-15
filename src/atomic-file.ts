import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"

const fileQueues = new Map<string, Promise<void>>()

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined
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
  try {
    await writeFile(tmpPath, text, { encoding: "utf8", flag: "wx" })
    await rename(tmpPath, filePath)
  } finally {
    await rm(tmpPath, { force: true }).catch(() => undefined)
  }
}
