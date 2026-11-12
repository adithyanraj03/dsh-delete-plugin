/**
 * Wiring harness — no dependencies, plain node.
 *
 * Checks that the three places the package name lives agree (package.json,
 * the cordis.patch.yml insert row, and the client loader id), and that every
 * exported/shipped file actually exists: a file missing from `files` works
 * locally via link: and breaks after publish.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const patchPath = join(root, 'cordis.patch.yml')
const patch = readFileSync(patchPath, 'utf8')

// 1. The insert row's name MUST equal the package name: the loader imports
//    that exact specifier.
const rowName = /^\s*name:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m.exec(patch)?.[1]
assert.equal(rowName, pkg.name, 'cordis.patch.yml row name must equal package.json name')

// 2. The row id is the storage/effect key: present and non-empty.
const rowId = /-\s*id:\s*([^\s'"]+)/.exec(patch)?.[1]
assert.ok(rowId, 'cordis.patch.yml insert row must carry an id')

// 3. The client loader id must equal the package name too.
const client = readFileSync(join(root, 'src/client.js'), 'utf8')
const loaderId = /id:\s*["']([^"']+)["']/.exec(client)?.[1]
assert.equal(loaderId, pkg.name, 'src/client.js loader id must equal package.json name')

// 4. main + every exports target exists (wildcard patterns are checked by their
//    base directory, since the literal glob is not a real path).
assert.ok(existsSync(join(root, pkg.main)), `main missing: ${pkg.main}`)
for (const [spec, target] of Object.entries(pkg.exports ?? {})) {
  const probe = target.includes('*') ? target.slice(0, target.indexOf('*')) : target
  assert.ok(existsSync(join(root, probe)), `exports["${spec}"] target missing: ${target}`)
}

// 5. Every shipped file exists.
for (const file of pkg.files ?? []) {
  assert.ok(existsSync(join(root, file)), `files entry missing: ${file}`)
}

// 6. The bundle patch points at the real file.
assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
assert.ok(existsSync(patchPath), 'cordis.patch.yml missing')

console.log(`PASS ${pkg.name}: row name/id + loader id agree; main, exports and files all present`)
