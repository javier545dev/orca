import { gitExecFileAsync } from './runner'

type GitExecOptions = {
  wslDistro?: string
}

/**
 * How far two bases may drift and still be worth retargeting a prepared checkout between.
 *
 * Measured on a 21,715-file repo: a local `main` and its `origin/main` were 5 commits and 74
 * files apart, while an abandoned fork's `main` — same branch name, so the same base family —
 * was 8,173 commits and 21,708 files from `origin/main`, i.e. a whole-tree checkout. A commit
 * count separates those by three orders of magnitude, so it is the cheap proxy for the tree diff
 * the retarget reset would have to write.
 */
export const RETARGET_MAX_COMMIT_DIVERGENCE = 100

async function countCommitsAhead(
  repoPath: string,
  fromRef: string,
  toRef: string,
  options: GitExecOptions
): Promise<number | null> {
  try {
    // `--max-count` stops the walk, so an unrelated history costs a bounded number of commits
    // rather than a full traversal. Both flags predate the Git 2.25 baseline.
    const { stdout } = await gitExecFileAsync(
      [
        'rev-list',
        '--count',
        `--max-count=${RETARGET_MAX_COMMIT_DIVERGENCE + 1}`,
        `${fromRef}..${toRef}`
      ],
      { cwd: repoPath, ...options }
    )
    const count = Number.parseInt(stdout.trim(), 10)
    return Number.isNaN(count) ? null : count
  } catch {
    return null
  }
}

async function hasCommonHistory(
  repoPath: string,
  leftRef: string,
  rightRef: string,
  options: GitExecOptions
): Promise<boolean> {
  try {
    const { stdout } = await gitExecFileAsync(['merge-base', leftRef, rightRef], {
      cwd: repoPath,
      ...options
    })
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

/**
 * Whether retargeting a checkout prepared at `preparedBase` onto `targetBase` stays cheap.
 *
 * Fails closed: an unreadable ref or a failed walk means the drift is unknown, and an unknown
 * drift must not authorize reusing the checkout — the cold create path is the safe answer.
 */
export async function isWithinRetargetDivergence(
  repoPath: string,
  preparedBase: string,
  targetBase: string,
  options: GitExecOptions = {}
): Promise<boolean> {
  // Both directions: commits the target adds decide what the reset writes, commits only the
  // preparation has decide what it must delete.
  const [ahead, behind] = await Promise.all([
    countCommitsAhead(repoPath, preparedBase, targetBase, options),
    countCommitsAhead(repoPath, targetBase, preparedBase, options)
  ])
  if (ahead === null || behind === null || ahead + behind > RETARGET_MAX_COMMIT_DIVERGENCE) {
    return false
  }
  // Only now: `merge-base` has no `--max-count`, so on unrelated histories it would walk both of
  // them in full. Reaching here already proved neither side is more than the cap ahead of the
  // other, which bounds that walk — and unrelated histories of any size fail the counts first.
  // Required because unrelated histories replace the whole tree however few commits they carry.
  return hasCommonHistory(repoPath, preparedBase, targetBase, options)
}
