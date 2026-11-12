/**
 * session-delete — host half of dsh-delete-plugin.
 *
 * Two capabilities, both exposed as one Typert Remote namespace (`sessionDelete`)
 * so the browser half calls them through the api-gateway:
 *
 *  1. deleteSession(sessionId, platform) — permanently remove a session:
 *     - a LIVE session with an ACTIVE turn is refused (`session-running`);
 *     - an idle live agent is torn down the way the agent factory tears down
 *       (cancel + scope dispose + agent detach + session detach), so the store
 *       drops it and `session/disposed` publishes `host/session-removed`;
 *     - a maintenance phase is aborted and given a bounded wait to settle so no
 *       append resurrects the log;
 *     - the persisted per-session directory (the JSONL log + session-local
 *       files) is physically removed through the `subprocess` service, the only
 *       sanctioned OS-level deletion capability, trying several interpreters;
 *     - the persistence listing is re-checked so the session is gone for good.
 *
 *  2. pinWorkspace / unpinWorkspace / getPinnedWorkspaces — a durable,
 *     registry-global workspace pin set (most recently pinned first), stored in
 *     this plugin's own storage domain. The browser half surfaces pinned
 *     workspaces ahead of the rest and paints a pin badge; the host only owns
 *     the set, never the workspace accounting.
 *
 * Every handler returns the same JSON envelope:
 *   { ok: true,  value: {...} }
 * | { ok: false, error: { code, message } }
 *
 * @module session-delete
 */
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

export const name = 'session-delete'

// timer backs the bounded maintenance wait; everything else is soft-injected so
// a deployment missing one service degrades this plugin instead of the row.
export const inject = ['timer']

/* ------------------------------------------------------------------ *
 * Durable workspace-pin storage
 * ------------------------------------------------------------------ */

const pinDomainSpec = defineDomain({
  // Storage-domain names must match /^[a-z][a-z0-9_]*$/ — underscores, not hyphens.
  name: 'session_delete',
  version: 1,
  global: {
    schema: z.object({
      pinnedWorkspaceIds: z.array(z.string()).default([]),
    }),
    initial: { pinnedWorkspaceIds: [] },
  },
  tables: {},
})

/**
 * Open the pin domain once and load the stored set into `state`. Resolves to the
 * global handle (or null when storage is unavailable, in which case pins live
 * only for this host run). Lazy so `apply` stays synchronous.
 */
function ensureStorage(ctx, state) {
  if (state.storagePromise === undefined) {
    state.storagePromise = (async () => {
      const storageDomain = ctx.get('storageDomain')
      if (storageDomain === undefined) {
        ctx.get('logger')?.warn?.('[session-delete] storageDomain missing; workspace pins will not persist')
        return null
      }
      try {
        const domain = await storageDomain.open(pinDomainSpec)
        ctx.effect(() => () => domain.close(), 'session-delete.domainClose')
        const stored = domain.global.get()
        state.pinnedWorkspaceIds = Array.isArray(stored?.pinnedWorkspaceIds)
          ? stored.pinnedWorkspaceIds.filter((id) => typeof id === 'string')
          : []
        return domain.global
      } catch (error) {
        ctx.get('logger')?.warn?.(`[session-delete] pin storage open failed: ${String(error)}`)
        return null
      }
    })()
  }
  return state.storagePromise
}

async function persistPins(ctx, state) {
  const global = await ensureStorage(ctx, state)
  if (global !== null) await global.set({ pinnedWorkspaceIds: state.pinnedWorkspaceIds })
}

/* ------------------------------------------------------------------ *
 * Deletion implementation (module-private)
 * ------------------------------------------------------------------ */

/** Remove the trailing path segment (dirname) without node:path. */
function dirnameOf(path) {
  if (typeof path !== 'string' || path.length === 0) return path
  const stripped = path.replace(/[\\/]+$/, '')
  const at = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf('\\'))
  return at <= 0 ? stripped : stripped.slice(0, at)
}

/** JSON-safe failure branch. */
function rejected(code, message) {
  return { ok: false, error: { code, message } }
}

/** JSON-safe success branch. */
function success(value) {
  return { ok: true, value }
}

/**
 * Tear down a live-but-idle session the way the agent factory's own teardown
 * does: cancel the machine, dispose the agent scope, then detach the agent and
 * the session from their registries. `session/disposed` publishes
 * `host/session-removed` to connected clients, so the sidebar drops the row.
 */
async function tearDownLiveSession(ctx, sessionId) {
  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  const agent = agents === undefined ? undefined : agents.get(sessionId)
  const sessionEntry = sessions && sessions.store ? sessions.store.get(sessionId) : undefined
  if (sessionEntry === undefined) return { ok: true } // nothing live to tear down

  if (agent !== undefined) {
    const phase = agent.phase && typeof agent.phase.kind === 'string' ? agent.phase.kind : 'idle'
    if (agent.status === 'running' && phase !== 'maintenance') {
      return {
        ok: false,
        code: 'session-running',
        message: `Session "${sessionId}" is still running. Stop it before permanently deleting it.`,
      }
    }
    try {
      agent.cancel({ kind: 'deleted' }, { keepInbox: false })
    } catch {
      /* best effort */
    }
    if (phase === 'maintenance') {
      for (let i = 0; i < 40; i += 1) {
        if (agent.phase && agent.phase.kind === 'idle') break
        await ctx.timeout(50)
      }
      if (agent.phase && agent.phase.kind !== 'idle') {
        return {
          ok: false,
          code: 'session-busy',
          message: `Session "${sessionId}" is busy with background work. Try again in a moment.`,
        }
      }
    }
    try {
      if (agent.scope && typeof agent.scope.dispose === 'function') await agent.scope.dispose()
    } catch {
      /* best effort — the detaches below still remove the registrations */
    }
    try {
      const agentEntry = agents.store ? agents.store.get(sessionId) : undefined
      if (agentEntry !== undefined && typeof agents.detachEntered === 'function') {
        agents.detachEntered(agentEntry)
      }
    } catch {
      /* best effort */
    }
  }

  try {
    if (typeof sessions.detachEntered === 'function') sessions.detachEntered(sessionEntry)
  } catch {
    /* best effort */
  }
  return { ok: true }
}

/** PowerShell recursive removal — `-LiteralPath` keeps the path unglobbed. */
function powershellArgv(program, dir) {
  return [program, '-NoProfile', '-NonInteractive', '-Command', 'Remove-Item', '-LiteralPath', dir, '-Recurse', '-Force']
}

/** POSIX recursive removal — `--` keeps a leading-dash path an operand. */
function rmArgv(program, dir) {
  return [program, '-rf', '--', dir]
}

/**
 * Every interpreter that can remove the session directory, best first. Absolute
 * paths built from the environment lead because a bare name is only found when
 * its directory sits on the host PATH, which a delete must not assume.
 */
function deletionCommands(dir, preferWindows) {
  const env = typeof process === 'object' && process !== null && process.env ? process.env : {}
  const system32 = `${env.SystemRoot || env.windir || 'C:\\WINDOWS'}\\System32`
  const windows = [
    [env.ComSpec || `${system32}\\cmd.exe`, '/d', '/s', '/c', 'rmdir', '/s', '/q', dir],
    powershellArgv(`${system32}\\WindowsPowerShell\\v1.0\\powershell.exe`, dir),
    powershellArgv('pwsh.exe', dir),
    powershellArgv('powershell.exe', dir),
  ]
  const posix = [rmArgv('/bin/rm', dir), rmArgv('/usr/bin/rm', dir), rmArgv('rm', dir)]
  return preferWindows ? [...windows, ...posix] : [...posix, ...windows]
}

/** The child's stderr, when the backend collected any — trimmed for a message. */
function stderrOf(handle) {
  try {
    const collected = handle && handle.collected ? handle.collected.stderr : undefined
    if (collected === undefined || typeof collected.finalize !== 'function') return ''
    const text = collected.finalize().text
    return typeof text === 'string' ? text.trim().replace(/\s+/g, ' ').slice(0, 200) : ''
  } catch {
    return ''
  }
}

/**
 * Spawn one deletion command and wait for its exit. `cwd` must lie OUTSIDE the
 * directory being removed: Windows will not delete a directory that a live
 * process holds as its working directory.
 */
async function runDeletion(subprocess, argv, cwd) {
  if (typeof subprocess.resolveExecutable === 'function') {
    try {
      await subprocess.resolveExecutable(argv[0])
    } catch (error) {
      return { detail: error && error.message ? error.message : 'not an executable' }
    }
  }
  const handle = subprocess.spawn({
    argv,
    cwd,
    stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
    graceMs: 20000,
  })
  const outcome = await handle.done
  if (outcome && outcome.exitCode === 0) return true
  const status =
    outcome === undefined ? 'no exit outcome' : `exit ${outcome.exitCode}${outcome.signal ? ` ${outcome.signal}` : ''}`
  const why = stderrOf(handle)
  return { detail: why.length > 0 ? `${status}: ${why}` : status }
}

// dsh 0.1.5 changed sessionPersistence.list() to return snapshots shaped
// { header, revision, sizeBytes }; earlier builds returned the headers themselves.
const headerOf = (entry) =>
  entry !== null && typeof entry === 'object' && entry.header !== undefined ? entry.header : entry

/** Core delete-session handler. */
async function handleDelete(ctx, args) {
  const sessionId =
    args && typeof args.sessionId === 'string' && args.sessionId.length > 0 ? args.sessionId : null
  if (sessionId === null) return rejected('bad-request', 'deleteSession requires a string sessionId')

  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  const subprocess = ctx.get('subprocess')
  if (sessions === undefined || persistence === undefined || subprocess === undefined) {
    return rejected(
      'delete-unsupported',
      'this deployment does not expose the services needed to delete a session (sessions, sessionPersistence or subprocess is missing)',
    )
  }

  // 1. Live sessions: refuse active turns, tear down idle ones.
  if (sessions.get(sessionId) !== undefined) {
    const teardown = await tearDownLiveSession(ctx, sessionId)
    if (!teardown.ok) return rejected(teardown.code, teardown.message)
  }

  // 2. Resolve the persisted session and its physical artifact.
  let header
  try {
    const headers = (await persistence.list()).map(headerOf)
    header = headers.find((h) => h && h.id === sessionId)
  } catch (error) {
    return rejected('delete-failed', `could not list persisted sessions: ${error && error.message ? error.message : String(error)}`)
  }
  if (header === undefined) return rejected('session-not-found', `Session "${sessionId}" does not exist.`)
  const location = persistence.locate(header)
  if (location === undefined || location === null || typeof location.path !== 'string') {
    return rejected('delete-unsupported', 'the persistence backend does not expose a removable per-session artifact')
  }
  const dir = dirnameOf(location.path)

  // A recursive removal must be aimed at a directory this session owns: the id
  // has to appear as a whole path segment, or a shared parent could be removed.
  if (!dir.split(/[\\/]/).some((segment) => segment === sessionId)) {
    return rejected('delete-unsupported', `refusing to remove "${dir}": it is not a directory owned by session "${sessionId}"`)
  }

  // 3. Remove the session directory, trying each interpreter; keep every failure.
  const platform = args && typeof args.platform === 'string' ? args.platform : ''
  const failures = []
  for (const argv of deletionCommands(dir, platform === 'win32')) {
    let outcome
    try {
      outcome = await runDeletion(subprocess, argv, dirnameOf(dir))
    } catch (error) {
      failures.push(`${argv[0]}: ${error && error.message ? error.message : String(error)}`)
      continue
    }
    if (outcome !== true) {
      failures.push(`${argv[0]}: ${outcome.detail}`)
      continue
    }
    // 4. Confirm the session is gone from persistence.
    const remaining = (await persistence.list()).map(headerOf).some((h) => h && h.id === sessionId)
    if (!remaining) return success({ sessionId, removed: dir })
    failures.push(`${argv[0]}: exited 0 but the session log is still listed`)
  }
  return rejected('delete-failed', `Failed to delete session "${sessionId}" (${dir}): ${failures.join('; ')}`)
}

/* ------------------------------------------------------------------ *
 * Remote service: client -> host RPC through the api-gateway
 * ------------------------------------------------------------------ */

class SessionDeleteRemote extends TypertRemoteService {
  constructor(ownerCtx, state) {
    super(ownerCtx, 'sessionDelete')
    this.state = state
  }

  deleteSession(sessionId, platform) {
    return handleDelete(this.ctx, { sessionId, platform })
  }

  async getPinnedWorkspaces() {
    await ensureStorage(this.ctx, this.state)
    return success({ pinnedWorkspaceIds: [...this.state.pinnedWorkspaceIds] })
  }

  async pinWorkspace(workspaceId) {
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
      return rejected('bad-request', 'pinWorkspace requires a string workspaceId')
    }
    const registry = this.ctx.get('workspaceRegistry')
    if (registry !== undefined && typeof registry.get === 'function' && registry.get(workspaceId) === undefined) {
      return rejected('workspace-not-found', `Workspace "${workspaceId}" does not exist.`)
    }
    await ensureStorage(this.ctx, this.state)
    if (!this.state.pinnedWorkspaceIds.includes(workspaceId)) {
      this.state.pinnedWorkspaceIds = [workspaceId, ...this.state.pinnedWorkspaceIds]
      await persistPins(this.ctx, this.state)
    }
    return success({ pinnedWorkspaceIds: [...this.state.pinnedWorkspaceIds] })
  }

  async unpinWorkspace(workspaceId) {
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
      return rejected('bad-request', 'unpinWorkspace requires a string workspaceId')
    }
    await ensureStorage(this.ctx, this.state)
    if (this.state.pinnedWorkspaceIds.includes(workspaceId)) {
      this.state.pinnedWorkspaceIds = this.state.pinnedWorkspaceIds.filter((id) => id !== workspaceId)
      await persistPins(this.ctx, this.state)
    }
    return success({ pinnedWorkspaceIds: [...this.state.pinnedWorkspaceIds] })
  }

  async setPinnedWorkspaceOrder(ids) {
    if (!Array.isArray(ids)) return rejected('bad-request', 'setPinnedWorkspaceOrder requires an array of workspace ids')
    await ensureStorage(this.ctx, this.state)
    const current = this.state.pinnedWorkspaceIds
    const pinnedSet = new Set(current)
    // Honor the caller's order for known pins, then append any pinned ids the
    // caller omitted, so a reorder can never drop a pin.
    const ordered = ids.filter((id) => typeof id === 'string' && pinnedSet.has(id))
    for (const id of current) if (!ordered.includes(id)) ordered.push(id)
    this.state.pinnedWorkspaceIds = ordered
    await persistPins(this.ctx, this.state)
    return success({ pinnedWorkspaceIds: [...ordered] })
  }
}

/** Emulate the @Remote decorator without decorator syntax. */
function markRemoteMethod(prototype, method) {
  Remote(method)(prototype[method], {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    access: { has() { return false }, get() { return undefined } },
    addInitializer(fn) { fn.call(Object.create(prototype)) },
  })
}
for (const method of ['deleteSession', 'getPinnedWorkspaces', 'pinWorkspace', 'unpinWorkspace', 'setPinnedWorkspaceOrder']) {
  markRemoteMethod(SessionDeleteRemote.prototype, method)
}

export function apply(ctx) {
  const state = { pinnedWorkspaceIds: [], storagePromise: undefined }
  new SessionDeleteRemote(ctx, state)
  try {
    ctx.get('logger')?.info?.('[session-delete] mounted (session delete + workspace pin)')
  } catch {
    /* no logger: mounting still succeeds */
  }
}

export default { apply, inject, name }