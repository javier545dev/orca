import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import {
  WORKTREE_CREATE_PREPARATION_DIRECTORY,
  createWorktreePreparationLockReason
} from '../shared/worktree/create-preparation'
import type { AddWorktreeOptions } from './git/worktree'
import {
  discardPreparedWorktree,
  prepareWorktreeCreateCheckout
} from './git/worktree-create-preparation'
import { toHostFilesystemPath } from './host-tree-removal'
import { preparationEntryKey, preparationPathKey } from './worktree-create-preparation-claim'
import {
  _resetStalePreparationReclaimForTests,
  reclaimStaleWorktreePreparations
} from './worktree-create-preparation-reclaim'

export const WORKTREE_CREATE_PREPARATION_TTL_MS = 5 * 60_000
export const WORKTREE_CREATE_PREPARATION_LIMIT = 3

export type PreparationEntry = {
  key: string
  repoPath: string
  repoPathKey: string
  workspaceRoot: string
  workspaceRootKey: string
  wslDistro: string
  baseBranch: string
  canonicalBase: string
  preparedPath: string
  options: AddWorktreeOptions
  createdAt: number
  ready: Promise<void>
  expiration: NodeJS.Timeout
}

export type StartPreparationArgs = {
  repoPath: string
  workspaceRoot: string
  baseBranch: string
  canonicalBase: string
  options: AddWorktreeOptions
}

const preparations = new Map<string, PreparationEntry>()

function pathOps(path: string): Pick<typeof posix, 'dirname' | 'join'> {
  return isWindowsAbsolutePathLike(path) ? win32 : posix
}

async function discardEntry(entry: PreparationEntry): Promise<void> {
  await entry.ready.catch(() => {})
  await discardPreparedWorktree(entry.repoPath, entry.preparedPath, entry.options).catch(() => {})
}

function expireEntry(entry: PreparationEntry): void {
  if (preparations.get(entry.key) !== entry) {
    return
  }
  preparations.delete(entry.key)
  void discardEntry(entry)
}

function enforcePreparationLimit(): void {
  while (preparations.size >= WORKTREE_CREATE_PREPARATION_LIMIT) {
    const oldest = [...preparations.values()].sort(
      (left, right) => left.createdAt - right.createdAt
    )[0]
    if (!oldest) {
      return
    }
    preparations.delete(oldest.key)
    clearTimeout(oldest.expiration)
    void discardEntry(oldest)
  }
}

export function listPreparations(): PreparationEntry[] {
  return [...preparations.values()]
}

export function findPreparation(
  repoPathKey: string,
  workspaceRootKey: string,
  canonicalBase: string,
  wslDistro: string
): PreparationEntry | undefined {
  return preparations.get(
    preparationEntryKey(repoPathKey, workspaceRootKey, canonicalBase, wslDistro)
  )
}

/** Removes an entry from the pool so no other create can claim it. Callers must run this in the
 *  same synchronous turn as the selection that produced `entry`. */
export function takePreparation(entry: PreparationEntry): void {
  preparations.delete(entry.key)
  clearTimeout(entry.expiration)
}

export function startPreparation({
  repoPath,
  workspaceRoot,
  baseBranch,
  canonicalBase,
  options
}: StartPreparationArgs): Promise<void> {
  const repoPathKey = preparationPathKey(repoPath)
  const workspaceRootKey = preparationPathKey(workspaceRoot)
  const wslDistro = options.wslDistro ?? ''
  const key = preparationEntryKey(repoPathKey, workspaceRootKey, canonicalBase, wslDistro)
  enforcePreparationLimit()
  const preparationId = `${process.pid}-${randomUUID()}`
  const lockReason = createWorktreePreparationLockReason(preparationId)
  const preparationRoot = pathOps(workspaceRoot).join(
    workspaceRoot,
    WORKTREE_CREATE_PREPARATION_DIRECTORY
  )
  const preparedPath = pathOps(workspaceRoot).join(preparationRoot, preparationId)
  const entry = {} as PreparationEntry
  const expiration = setTimeout(() => expireEntry(entry), WORKTREE_CREATE_PREPARATION_TTL_MS)
  expiration.unref()
  Object.assign(entry, {
    key,
    repoPath,
    repoPathKey,
    workspaceRoot,
    workspaceRootKey,
    wslDistro,
    baseBranch,
    canonicalBase,
    preparedPath,
    options,
    createdAt: Date.now(),
    expiration,
    ready: (async () => {
      await reclaimStaleWorktreePreparations(repoPathKey, repoPath, options)
      await mkdir(toHostFilesystemPath(preparationRoot), { recursive: true })
      // Already canonical, so the add re-resolves nothing.
      await prepareWorktreeCreateCheckout(
        repoPath,
        preparedPath,
        canonicalBase,
        lockReason,
        options
      )
    })()
  } satisfies PreparationEntry)
  preparations.set(key, entry)
  void entry.ready.catch(() => {
    if (preparations.get(key) === entry) {
      preparations.delete(key)
      clearTimeout(entry.expiration)
    }
  })
  return entry.ready
}

export async function _resetPreparationPoolForTests(): Promise<void> {
  const entries = [...preparations.values()]
  preparations.clear()
  _resetStalePreparationReclaimForTests()
  await Promise.all(
    entries.map(async (entry) => {
      clearTimeout(entry.expiration)
      await discardEntry(entry)
    })
  )
}
