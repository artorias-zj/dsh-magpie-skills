/**
 * dsh-magpie-skills —— magpie 技能库的定位与发现。
 *
 * **库在哪**：magpie 引擎由 dsh-our-free-model 以「独立 HOME」启动
 * （`HOME=<dshHome>/our-free-model/magpie/agent-home`，
 * `XDG_CONFIG_HOME=<dshHome>/our-free-model/magpie/config`）。于是它把技能库落在：
 *
 *   <dshHome>/our-free-model/magpie/config/magpie/library/skills/<name>/SKILL.md
 *   <dshHome>/our-free-model/magpie/config/magpie/library.json  ← 「对哪个 agent 启用」的记录
 *
 * 另有一份软链接视图 `.../magpie/agent-home/.dsh/skills/<name>`（引擎给 dsh 用的落点），
 * 指向同一批目录。发现时按 realpath 去重，同名技能不会出现两次。
 *
 * **为什么只认 library.json 的 applied.dsh.skills**：面板上「启用」的含义就是
 * 「这条技能应用到了哪个 agent」。用户把某条只挂给 Claude 时，它不该出现在 DSH 的
 * `/` 里。该字段缺失时（旧引擎 / 手写库）退化为「全部可见」—— 宁可多列也不漏。
 *
 * @module dsh-magpie-skills/library
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { parseSkillFile } from './frontmatter.js'

/** 递归发现的最大深度（目录束通常在第 1 层）。 */
const MAX_DEPTH = 3
/** 扫描跳过的目录名。 */
const SKIP_NAMES = new Set(['node_modules', '.git', '.hg', '.svn'])
/** 技能名约束，与 DSH 注册表一致；不满足会被整组丢弃，所以先本地过滤。 */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 解析 DSH 主目录。 */
export function resolveDshHome(config = {}) {
  if (typeof config.dshHome === 'string' && config.dshHome !== '') return resolve(config.dshHome)
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') return resolve(process.env.DSH_HOME)
  return join(homedir(), '.dsh')
}

/** magpie 引擎的数据目录。 */
export function resolveMagpieHome(config = {}) {
  if (typeof config.magpieHome === 'string' && config.magpieHome !== '') {
    if (!isAbsolute(config.magpieHome)) throw new TypeError('magpieHome must be an absolute path')
    return resolve(config.magpieHome)
  }
  return join(resolveDshHome(config), 'our-free-model', 'magpie')
}

/**
 * 技能库根目录（按优先级）与元数据文件。
 *
 * @returns `{ roots: string[], libraryJson: string }`
 */
export function resolveLibraryPaths(config = {}) {
  const home = resolveMagpieHome(config)
  const configDir = join(home, 'config', 'magpie')
  return {
    roots: [
      // 引擎自己的库：权威来源。
      join(configDir, 'library', 'skills'),
      // 引擎给 dsh 落的软链接视图：手工放进去的技能也能被发现。
      join(home, 'agent-home', '.dsh', 'skills'),
    ],
    libraryJson: join(configDir, 'library.json'),
  }
}

/** 路径是否存在。 */
async function exists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/** 读 library.json；不存在或损坏时返回 `undefined`（调用方按「全部可见」处理）。 */
export async function readLibraryMeta(libraryJson) {
  try {
    const parsed = JSON.parse(await readFile(libraryJson, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** 该库记录给某个 agent 启用了哪些技能；无记录时返回 `undefined`（= 全部可见）。 */
export function appliedSkillsFor(meta, agent) {
  const applied = meta?.applied
  if (applied === null || typeof applied !== 'object') return undefined
  const entry = applied[agent]
  if (entry === null || typeof entry !== 'object') return undefined
  if (!Array.isArray(entry.skills)) return undefined
  return entry.skills.filter((name) => typeof name === 'string')
}

/**
 * 在一个根目录下发现技能文件。
 *
 * 一条技能 = 一个含 `SKILL.md` 的目录（目录束），或根目录下的平铺 `<name>.md`。
 * 目录自身有 SKILL.md 就不再下钻（与官方提供方一致）；`.disabled` 一律跳过 ——
 * 停用即改名，界面上关掉的技能不该出现在 `/` 里。
 */
export async function discoverInRoot(rootPath) {
  const found = []
  const walk = async (dir, depth) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
      found.push({ file: join(dir, 'SKILL.md'), dir, kind: 'bundle' })
      return
    }
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name) || entry.name.endsWith('.disabled')) continue
      if (depth === 1 && entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'SKILL.md') {
        found.push({ file: join(dir, entry.name), dir, kind: 'flat' })
        continue
      }
      if (entry.isDirectory() && depth < MAX_DEPTH) await walk(join(dir, entry.name), depth + 1)
    }
  }
  if (await exists(rootPath)) await walk(rootPath, 1)
  return found
}

/** 去重键：Windows 路径大小写不敏感。 */
function dedupeKey(target) {
  const resolved = resolve(target)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * 收集库中全部可注册的技能（不含正文）。
 *
 * 正文留到 `get()` 再读：列目录是热路径，不该每次都读一遍所有 SKILL.md。
 *
 * @returns `{ skills, roots, warnings, filtered }`
 */
export async function collectLibrary(config = {}) {
  const { roots, libraryJson } = resolveLibraryPaths(config)
  const meta = await readLibraryMeta(libraryJson)
  const agent = typeof config.agent === 'string' && config.agent !== '' ? config.agent : 'dsh'
  const allow = config.onlyApplied === false ? undefined : appliedSkillsFor(meta, agent)
  const allowSet = allow === undefined ? undefined : new Set(allow)

  const warnings = []
  const byPath = new Map()
  let filtered = 0

  for (const rootPath of roots) {
    for (const entry of await discoverInRoot(rootPath)) {
      let real
      try {
        real = await realpath(entry.file)
      } catch {
        continue
      }
      const key = dedupeKey(real)
      if (byPath.has(key)) continue

      let raw
      try {
        raw = await readFile(entry.file, 'utf8')
      } catch {
        continue
      }
      const parsed = parseSkillFile(raw)
      if (parsed === undefined || parsed.name === '' || parsed.description === '') continue
      if (!SKILL_NAME.test(parsed.name)) {
        warnings.push(`技能名不合规，已跳过：${parsed.name}（${entry.file}）`)
        continue
      }
      // 按名字匹配：面板显示 frontmatter 的 name，library.json 记的是目录名，两者取其一命中即可。
      if (allowSet !== undefined && !allowSet.has(parsed.name) && !allowSet.has(basename(entry.dir))) {
        filtered += 1
        continue
      }

      byPath.set(key, {
        name: parsed.name,
        description: parsed.description,
        ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
        modelInvocable: parsed.modelInvocable,
        userInvocable: parsed.userInvocable,
        file: entry.file,
        dir: dirname(entry.file),
        kind: entry.kind,
      })
    }
  }

  const skills = [...byPath.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { skills, roots, warnings, filtered }
}

/** 读取一条技能的完整正文（每次重读，磁盘上的修改立刻生效）。 */
export async function loadSkillFile(file) {
  return await readFile(file, 'utf8')
}
