/**
 * Anti-drift harness for the DeepSeek Harness plugin (@riantr/pyroduct-dsh).
 *
 * The plugin is a spawner and a formatter: every fact it shows comes from the
 * pyroduct module through the `cmd/jsoncli` bridge. What it *hard-codes* is
 * therefore a set of claims about that module, and each one is a number or a
 * list that moves with every release:
 *
 *   - `FACES` in index.js, which is the `enum` of the `pyroduct_face` tool's
 *     `kind` parameter. A face missing here is not merely undocumented, it is
 *     REJECTED by the schema — the model cannot ask for it at all. The source
 *     comment calls this list "anti-drift"; nothing checked it, and it had
 *     fallen three faces behind (fleet / mutants / mbti).
 *   - the test count quoted in the `pyroduct_gates` description and in the
 *     README, which had drifted to 129 while the suite runs 197.
 *   - the three registered tool names.
 *
 * The module is the oracle, never a copy kept in this repo: the bridge's reply
 * envelope already carries its own `faces` list (that is what the field is
 * documented to be for), and `moon test` prints the real total. So these checks
 * update themselves when the module moves — there is no pin to bump here.
 *
 * Usage:
 *   PYRODUCT_PROJECT_DIR=/path/to/pyroduct node tools/validate.mjs
 *
 * The project dir is the same one the plugin is configured with (the row config
 * `projectDir`), and it must have its bridge built; the workflow builds it.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PROJECT = process.env.PYRODUCT_PROJECT_DIR
const MOON = process.env.MOON_PATH && process.env.MOON_PATH.length > 0 ? process.env.MOON_PATH : 'moon'
const BRIDGE = path.join(PROJECT ?? '', '_build', 'js', 'debug', 'build', 'cmd', 'jsoncli', 'jsoncli.js')

const problems = []
let checkCount = 0
function check(label, condition, detail = '') {
  const ok = Boolean(condition)
  checkCount += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) problems.push(label)
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: String(error) }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

// ---------------------------------------------------------------- static shape

const indexSource = readFileSync(path.join(ROOT, 'index.js'), 'utf8')

const facesMatch = indexSource.match(/const FACES\s*=\s*\[([\s\S]*?)\]/)
const faces = facesMatch ? [...facesMatch[1].matchAll(/'([a-z][a-z-]*)'/g)].map((m) => m[1]) : []
check('index.js declares a FACES list', faces.length > 0, `${faces.length} faces`)
check('FACES has no duplicates', new Set(faces).size === faces.length,
  faces.length - new Set(faces).size === 0 ? 'none' : `${faces.length - new Set(faces).size} duplicate(s)`)

for (const tool of ['pyroduct_report', 'pyroduct_face', 'pyroduct_gates']) {
  check(`tool ${tool} is registered`, indexSource.includes(`name: '${tool}'`))
}

for (const file of ['package.json', ...readdirSync(path.join(ROOT, 'locale')).map((f) => path.join('locale', f))]) {
  let parsed = true
  let detail = ''
  try {
    JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'))
  } catch (error) {
    parsed = false
    detail = String(error.message).slice(0, 120)
  }
  check(`${file} is valid JSON`, parsed, detail)
}

const syntax = await run(process.execPath, ['--check', path.join(ROOT, 'index.js')])
check('index.js parses as an ES module', syntax.code === 0, syntax.stderr.trim().split('\n')[0] ?? '')

// --------------------------------------------------- claims that need the module

if (!PROJECT || !existsSync(PROJECT)) {
  console.log(`\n::error::PYRODUCT_PROJECT_DIR is not a directory: ${PROJECT}`)
  process.exit(1)
}

if (!existsSync(BRIDGE)) {
  const built = await run(MOON, ['build', '--target', 'js'], { cwd: PROJECT })
  check('the jsoncli bridge is available (built it if it was missing)', existsSync(BRIDGE),
    built.stderr.trim().split('\n').slice(-1)[0] ?? '')
}
if (!existsSync(BRIDGE)) {
  console.log(`\n::error::no bridge at ${BRIDGE}; cannot ask the module anything`)
  process.exit(1)
}

const replyRun = await run(process.execPath, [BRIDGE, JSON.stringify({ kind: 'report' })], { cwd: PROJECT })
let reply = null
try {
  reply = JSON.parse(replyRun.stdout.trim().split('\n').pop())
} catch {
  // reported below
}
check('the bridge answers with a parseable JSON envelope', reply !== null,
  (replyRun.stdout.trim().split('\n').pop() ?? replyRun.stderr).slice(0, 120))
check('the bridge reports ok', reply?.ok === true, String(reply?.error ?? ''))
check('the bridge actually rendered the face', typeof reply?.rendered === 'string' && reply.rendered.length > 0,
  `${String(reply?.rendered?.length ?? 0)} chars`)

const moduleFaces = Array.isArray(reply?.faces) ? reply.faces : []
const inModuleOnly = moduleFaces.filter((f) => !faces.includes(f))
const inPluginOnly = faces.filter((f) => !moduleFaces.includes(f))
check('FACES === the bridge faces() (no face the plugin cannot ask for)',
  inModuleOnly.length === 0,
  inModuleOnly.length > 0 ? `module has, plugin enum lacks: ${inModuleOnly.join(', ')}` : 'sets equal')
check('FACES === the bridge faces() (no face the module would reject)',
  inPluginOnly.length === 0,
  inPluginOnly.length > 0 ? `plugin enum claims, module lacks: ${inPluginOnly.join(', ')}` : 'sets equal')

// The test count is quoted in two places; both must match what `moon test` prints.
const testRun = await run(MOON, ['test'], { cwd: PROJECT })
const realTotal = (testRun.stdout + testRun.stderr).match(/Total tests:\s*(\d+),\s*passed/)?.[1]
check('the module test suite reports a total', Boolean(realTotal),
  realTotal ? `${realTotal} tests` : testRun.stdout.trim().split('\n').slice(-1)[0]?.slice(0, 120))
const realTotalNum = Number(realTotal)
for (const [where, source] of [['index.js', indexSource], ['README.md', readFileSync(path.join(ROOT, 'README.md'), 'utf8')]]) {
  const claim = [...source.matchAll(/(\d+)\s+tests/gi)].map((m) => Number(m[1]))
  check(`${where} quotes no stale test count`,
    claim.every((n) => n === realTotalNum),
    claim.length === 0 ? 'no count quoted'
      : claim.every((n) => n === realTotalNum) ? `${claim.join(', ')} matches ${realTotalNum}`
      : `quotes ${claim.join(', ')}, module runs ${realTotalNum}`)
}

console.log(`\n${checkCount} checks run`)
console.log(problems.length === 0
  ? `ALL CHECKS PASSED (${checkCount})`
  : `FAILURES (${checkCount - problems.length}/${checkCount} passed): ${problems.join(' | ')}`)
process.exit(problems.length === 0 ? 0 : 1)
