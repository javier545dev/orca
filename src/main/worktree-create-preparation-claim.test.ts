import { describe, expect, it, vi } from 'vitest'
import {
  selectPreparationForCreate,
  type PreparationCandidate
} from './worktree-create-preparation-claim'

function candidate(overrides: Partial<PreparationCandidate> = {}): PreparationCandidate {
  return {
    repoPathKey: '/repo',
    workspaceRootKey: '/workspace',
    wslDistro: '',
    baseBranch: 'origin/main',
    canonicalBase: 'refs/remotes/origin/main',
    createdAt: 1_000,
    ...overrides
  }
}

function request(overrides: Partial<Parameters<typeof selectPreparationForCreate>[1]> = {}) {
  return {
    repoPathKey: '/repo',
    workspaceRootKey: '/workspace',
    wslDistro: '',
    baseBranch: 'origin/main',
    canonicalBase: async () => 'refs/remotes/origin/main',
    ...overrides
  }
}

describe('selectPreparationForCreate', () => {
  it('matches the identical base without spending a ref probe', async () => {
    const canonicalBase = vi.fn(async () => 'refs/remotes/origin/main')

    const selection = await selectPreparationForCreate([candidate()], request({ canonicalBase }))

    expect(selection).toMatchObject({ kind: 'exact' })
    expect(canonicalBase).not.toHaveBeenCalled()
  })

  it('matches when the two sides spell the same ref differently', async () => {
    const selection = await selectPreparationForCreate(
      [candidate()],
      request({
        baseBranch: 'refs/remotes/origin/main',
        canonicalBase: async () => 'refs/remotes/origin/main'
      })
    )

    expect(selection).toEqual({
      kind: 'exact',
      candidate: candidate(),
      canonicalBase: 'refs/remotes/origin/main'
    })
  })

  it('retargets a local base onto the armed remote-tracking base of the same branch', async () => {
    const selection = await selectPreparationForCreate(
      [candidate()],
      request({ baseBranch: 'main', canonicalBase: async () => 'refs/heads/main' })
    )

    expect(selection).toEqual({
      kind: 'retarget',
      candidate: candidate(),
      canonicalBase: 'refs/heads/main'
    })
  })

  it('prefers the freshest armed entry when several share the family', async () => {
    const older = candidate({ canonicalBase: 'refs/remotes/origin/main', createdAt: 1 })
    const newer = candidate({ canonicalBase: 'refs/remotes/upstream/main', createdAt: 2 })

    const selection = await selectPreparationForCreate(
      [older, newer],
      request({ baseBranch: 'main', canonicalBase: async () => 'refs/heads/main' })
    )

    expect(selection).toMatchObject({ kind: 'retarget', candidate: newer })
  })

  it('refuses to retarget onto a different branch', async () => {
    const selection = await selectPreparationForCreate(
      [candidate()],
      request({
        baseBranch: 'origin/release',
        canonicalBase: async () => 'refs/remotes/origin/release'
      })
    )

    expect(selection).toEqual({ kind: 'miss', reason: 'base_mismatch' })
  })

  it('refuses to retarget onto a bare commit id, whose divergence is unbounded', async () => {
    const selection = await selectPreparationForCreate(
      [candidate()],
      request({
        baseBranch: '1f2e3d4c5b6a7988',
        canonicalBase: async () => '1f2e3d4c5b6a7988'
      })
    )

    expect(selection).toEqual({ kind: 'miss', reason: 'base_mismatch' })
  })

  it('names the key field that disagreed', async () => {
    await expect(selectPreparationForCreate([], request())).resolves.toEqual({
      kind: 'miss',
      reason: 'none_armed'
    })
    await expect(
      selectPreparationForCreate([candidate()], request({ repoPathKey: '/other-repo' }))
    ).resolves.toEqual({ kind: 'miss', reason: 'none_armed' })
    await expect(
      selectPreparationForCreate([candidate()], request({ wslDistro: 'Ubuntu' }))
    ).resolves.toEqual({ kind: 'miss', reason: 'wsl_distro_mismatch' })
    await expect(
      selectPreparationForCreate([candidate()], request({ workspaceRootKey: '/other' }))
    ).resolves.toEqual({ kind: 'miss', reason: 'workspace_root_mismatch' })
  })

  it('never crosses hosts to satisfy a family retarget', async () => {
    const selection = await selectPreparationForCreate(
      [candidate({ wslDistro: 'Ubuntu' })],
      request({ baseBranch: 'main', canonicalBase: async () => 'refs/heads/main' })
    )

    expect(selection).toEqual({ kind: 'miss', reason: 'wsl_distro_mismatch' })
  })
})
