import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import { isFolderRepo } from '../shared/repo-kind'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import {
  WORKTREE_CREATE_PREPARATION_DIRECTORY,
  createWorktreePreparationLockReason
} from '../shared/worktree/create-preparation'
import type { PreparedCheckoutMissReason } from '../shared/worktree/create-types'
import type { AddWorktreeOptions, AddWorktreeResult } from './git/worktree'
import { resolveLocalWorktreeBaseRef } from './git/worktree-base-ref-probe'
import {
  preparationEntryKey,
  preparationPathKey,
  selectPreparationForCreate
} from './worktree-create-preparation-claim'
import {
  _resetStalePreparationReclaimForTests,
  reclaimStaleWorktreePreparations
} from './worktree-create-preparation-reclaim'
import {
  discardPreparedWorktree,
  finalizePreparedWorktree,
  prepareWorktreeCreateCheckout
} from './git/worktree-create-preparation'
import {
  getLocalProjectWorktreeGitOptions,
  getWorktreeMirrorDistro
} from './project-runtime-git-options'
import { computeWorkspaceRootAsync, getWorktreePathSettings } from './ipc/worktree-logic'
import {
  recordPreparationConsume,
  resetPreparationConsumeHistoryForTests
} from './worktree-create-preparation-burst'
import { toHostFilesystemPath } from './host-tree-removal'

export const WORKTREE_CREATE_PREPARATION_TTL_MS = 5 * 60_000
export const WORKTREE_CREATE_PREPARATION_LIMIT = 3

type PreparationEntry = {
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

export type PreparedWorktreeCreateAttempt =
  | { status: 'hit'; retargeted: boolean; result: AddWorktreeResult }
  | { status: 'miss'; reason: PreparedCheckoutMissReason }

type ConsumePreparedWorktreeArgs = {
  repoPath: string
  workspaceRoot: string
  worktreePath: string
  branch: string
  baseBranch: string
  refreshLocalBaseRef?: boolean
  options?: AddWorktreeOptions
}

const preparations = new Map<string, PreparationEntry>()

function pathOps(path: string): Pick<typeof posix, 'dirname' | 'join'> {
  return isWindowsAbsolutePathLike(path) ? win32 : posix
}

function canonicalBaseRef(
  repoPath: string,
  baseBranch: string,
  options: AddWorktreeOptions
): Promise<string> {
  return resolveLocalWorktreeBaseRef(
    repoPath,
    baseBranch,
    options.wslDistro ? { wslDistro: options.wslDistro } : {}
  )
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

export async function prepareWorktreeCreateForRepo(
  store: Store,
  repo: Repo,
  baseBranch: string
): Promise<void> {
  if (repo.connectionId || isFolderRepo(repo)) {
    return
  }
  const options = getLocalProjectWorktreeGitOptions(store, repo)
  // Resolving a WSL repo's root spawns `wsl.exe`, and this runs while the create composer is open,
  // so it must not block the main thread. Key lookup and insert stay in one sync run after the await.
  // The mirror distro must be threaded exactly as createLocalWorktree threads it, or the two sides
  // key on different roots and every prepared checkout is discarded.
  const workspaceRoot = await computeWorkspaceRootAsync(
    repo.path,
    getWorktreePathSettings(repo, store.getSettings(), getWorktreeMirrorDistro(store, repo))
  )
  const canonicalBase = await canonicalBaseRef(repo.path, baseBranch, options)
  const existing = preparations.get(
    preparationEntryKey(
      preparationPathKey(repo.path),
      preparationPathKey(workspaceRoot),
      canonicalBase,
      options.wslDistro ?? ''
    )
  )
  if (existing) {
    return existing.ready
  }

  return startPreparation({
    repoPath: repo.path,
    workspaceRoot,
    baseBranch,
    canonicalBase,
    options
  })
}

type StartPreparationArgs = {
  repoPath: string
  workspaceRoot: string
  baseBranch: string
  canonicalBase: string
  options: AddWorktreeOptions
}

function startPreparation({
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
  const preparedPath = pathOps(workspaceRoot).join(
    workspaceRoot,
    WORKTREE_CREATE_PREPARATION_DIRECTORY,
    preparationId
  )
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
      await mkdir(
        toHostFilesystemPath(
          pathOps(workspaceRoot).join(workspaceRoot, WORKTREE_CREATE_PREPARATION_DIRECTORY)
        ),
        { recursive: true }
      )
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

type ClaimedPreparation =
  | { status: 'claimed'; entry: PreparationEntry; retargeted: boolean; canonicalBase: string }
  | { status: 'miss'; reason: PreparedCheckoutMissReason }

async function claimPreparedWorktree(
  args: ConsumePreparedWorktreeArgs,
  options: AddWorktreeOptions
): Promise<ClaimedPreparation> {
  const selection = await selectPreparationForCreate([...preparations.values()], {
    repoPathKey: preparationPathKey(args.repoPath),
    workspaceRootKey: preparationPathKey(args.workspaceRoot),
    wslDistro: options.wslDistro ?? '',
    baseBranch: args.baseBranch,
    canonicalBase: () => canonicalBaseRef(args.repoPath, args.baseBranch, options)
  })
  if (selection.kind === 'miss') {
    return { status: 'miss', reason: selection.reason }
  }
  const entry = selection.candidate
  preparations.delete(entry.key)
  clearTimeout(entry.expiration)
  try {
    await entry.ready
    return {
      status: 'claimed',
      entry,
      retargeted: selection.kind === 'retarget',
      canonicalBase: selection.canonicalBase
    }
  } catch {
    return { status: 'miss', reason: 'prepare_failed' }
  }
}

/** Replaces a just-consumed preparation, re-armed on the base the create actually used so the
 *  next one hits exactly — but only once the user has shown they are creating in a burst. A
 *  replacement costs a full checkout and ~5 minutes of disk until its TTL, so arming one after an
 *  isolated create spends that on nobody. Never awaited: create has already returned by the time
 *  the replacement checkout finishes. */
function rearmPreparation(
  entry: PreparationEntry,
  baseBranch: string,
  canonicalBase: string
): void {
  // Record first: a prefetch that re-armed this key while we finalized would otherwise swallow the
  // consume, and the next create would look isolated when it is really the middle of a burst.
  const continuesBurst = recordPreparationConsume(entry.key)
  if (
    !continuesBurst ||
    preparations.has(
      preparationEntryKey(entry.repoPathKey, entry.workspaceRootKey, canonicalBase, entry.wslDistro)
    )
  ) {
    return
  }
  void startPreparation({
    repoPath: entry.repoPath,
    workspaceRoot: entry.workspaceRoot,
    baseBranch,
    canonicalBase,
    options: entry.options
  }).catch(() => {
    // Why: a warm-up failure is recovered by the normal add on the next create.
  })
}

export async function consumePreparedWorktreeCreate(
  args: ConsumePreparedWorktreeArgs
): Promise<PreparedWorktreeCreateAttempt> {
  const options = args.options ?? {}
  const claim = await claimPreparedWorktree(args, options)
  if (claim.status === 'miss') {
    return { status: 'miss', reason: claim.reason }
  }
  const { entry } = claim
  try {
    await mkdir(toHostFilesystemPath(pathOps(args.worktreePath).dirname(args.worktreePath)), {
      recursive: true
    })
    // Finalize resolves the requested base itself and resets the prepared checkout onto that
    // commit, so a retargeted claim is handed over at the requested commit or not at all.
    const result = await finalizePreparedWorktree(
      args.repoPath,
      entry.preparedPath,
      args.worktreePath,
      args.branch,
      args.baseBranch,
      args.refreshLocalBaseRef,
      options
    )
    // Consuming the only prepared checkout leaves the next create cold. Re-arm for a user who is
    // creating in a burst; the TTL and the preparation limit still bound an unused replacement.
    rearmPreparation(entry, args.baseBranch, claim.canonicalBase)
    return { status: 'hit', retargeted: claim.retargeted, result }
  } catch (error) {
    await discardPreparedWorktree(args.repoPath, entry.preparedPath, options).catch(() => {})
    console.warn(
      '[worktree-create] prepared checkout could not be finalized; using normal add',
      error
    )
    return { status: 'miss', reason: 'finalize_failed' }
  }
}

export async function _resetWorktreeCreatePreparationsForTests(): Promise<void> {
  const entries = [...preparations.values()]
  preparations.clear()
  resetPreparationConsumeHistoryForTests()
  _resetStalePreparationReclaimForTests()
  await Promise.all(
    entries.map(async (entry) => {
      clearTimeout(entry.expiration)
      await discardEntry(entry)
    })
  )
}
