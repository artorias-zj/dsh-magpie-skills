/**
 * dsh-magpie-skills —— 把 magpie 技能库接进 DSH 的技能注册表。
 *
 * ## 这个插件存在的理由
 *
 * magpie（dsh-our-free-model 内嵌的引擎）自带一个技能库，面板上能装、能启停，
 * 但它和 DSH 自己的技能注册表是**两套互不相通的东西**：
 *
 *   - magpie 只把技能落成文件（`library/skills/<name>/SKILL.md`），并在
 *     `library.json` 里记「给哪个 agent 启用了哪几条」；
 *   - DSH 的会话 `/` 菜单与模型侧的 `skill` 工具都只认 `ctx.skills` 注册表。
 *
 * 两者的桥是一段**发现 + 注册**的代码，而 magpie 不提供、our-free-model 也不代劳
 * （它只跑引擎，不碰 `ctx.skills`）。于是在插件里装了 magpie 技能、面板上显示
 * 「已启用」，在 DSH 里输入 `/` 却一条都匹配不到 —— 这正是本插件要补的那段。
 *
 * ## 与官方提供方的对齐
 *
 * 候选字段与 `@deepseek-ai/dsh-skill-badge` 的 bundled provider 完全一致
 * （`invocation` / `source` / `provider` / `rank` / `locator` / `resourceBase`），
 * 取值语义也与 `@deepseek-ai/dsh-skill-filesystem` 对齐：
 *   - `disable-model-invocation: true` → 仅用户可调用（只能从 `/` 进）；
 *   - `user-invocable: false` → 不进 `/`；
 *   - rank 取 600（随包/外带技能一档），用户自己装在 `~/.dsh/skills`（400）的同名技能优先。
 *
 * @module dsh-magpie-skills
 */
import { watch } from 'node:fs'
import { collectLibrary, loadSkillFile, resolveDshHome, resolveLibraryPaths } from './library.js'
import { parseSkillFile } from './frontmatter.js'

/** 提供方名；`runtime` 是注册表保留名，不能占用。 */
export const PROVIDER_NAME = 'magpie-skills'

/**
 * 外带技能的 rank。官方分级：项目 `.dsh`(100) → 项目 `.agents`(200) →
 * 用户 `.dsh`(400) → 用户 `.agents`(500) → 随包(600)。
 * magpie 是外带库，排在用户自己的技能之后：同名时用户那份胜出。
 */
const RANK = 600

/** 变更合并窗口（毫秒）：一次安装会触发大量 fs 事件。 */
const DEBOUNCE_MS = 250

/**
 * 构造注册表提供方。
 *
 * `list()` 返回候选摘要，`get()` 按 locator 重读正文 —— 与官方提供方同一分工：
 * 列目录是热路径，不读正文；正文每次重读，磁盘改动立刻反映到下次加载。
 */
export function createProvider(config, logger) {
  const settings = {
    ...config,
    agent: typeof config?.agent === 'string' && config.agent !== '' ? config.agent : 'dsh',
  }

  const candidateOf = (skill) => ({
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
    invocation: { modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable },
    provider: PROVIDER_NAME,
    source: 'bundled',
    rank: RANK,
    path: skill.file,
    // locator 是候选与正文之间的唯一纽带，必须可序列化、可跨 list/get 复现。
    locator: { file: skill.file, dir: skill.dir, kind: skill.kind },
    resourceBase: { kind: 'directory', path: skill.dir },
  })

  return {
    name: PROVIDER_NAME,

    async list() {
      try {
        const { skills, warnings } = await collectLibrary(settings)
        for (const warning of warnings) logger?.warn?.(`dsh-magpie-skills: ${warning}`)
        return skills.map(candidateOf)
      } catch (error) {
        // 库不存在、被删、格式坏了都不该让整个目录报错：`/` 少几条技能只是降级。
        logger?.warn?.(`dsh-magpie-skills: 扫描 magpie 技能库失败：${String(error)}`)
        return []
      }
    },

    async get(candidate, lookup = {}) {
      const locator = candidate?.locator
      if (locator === null || typeof locator !== 'object' || typeof locator.file !== 'string') return undefined
      if (lookup?.signal?.aborted === true) return undefined

      let raw
      try {
        raw = await loadSkillFile(locator.file)
      } catch {
        // 文件已消失（面板上卸载了）：由调用方把该条从目录里移除。
        return undefined
      }
      const parsed = parseSkillFile(raw)
      if (parsed === undefined || parsed.name === '' || parsed.description === '') return undefined

      const { locator: _locator, rank: _rank, ...summary } = candidateOf({ ...parsed, file: locator.file, dir: locator.dir, kind: locator.kind })
      return {
        ...summary,
        // 正文里若有 `<SKILL_ROOT>` 占位（照 git clone 安装写的技能会用），换成真实目录。
        content: parsed.body.replaceAll('<SKILL_ROOT>', locator.dir) + addendum(parsed.name, locator.dir),
      }
    },
  }
}

/**
 * 插件环境下对原文的补充：技能的 `scripts/`、`assets/` 相对它自己的目录，
 * 不补一句模型会去会话工作目录里找。已在原文里写明目录的技能不重复添加。
 */
function addendum(name, dir) {
  return [
    '',
    '---',
    '',
    '## 在 DSH 里使用这条技能（magpie 技能库）',
    '',
    `- 本条来自 magpie 技能库，它的目录是 \`${dir}\`；上文提到的 \`scripts/\`、\`assets/\`、\`references/\` 都相对这个目录。`,
    '- 技能的启用/停用、更新都在 magpie 面板里做；本插件只负责把它接进 DSH 的 `/` 菜单，不复制、不改写文件内容。',
  ].join('\n') + '\n'
}

/**
 * 库目录监视：面板上装/删/启停技能后，下一次目录刷新即生效，无需重启。
 *
 * 只监视已存在的库根；根还没建出来（用户首次打开 magpie 前）时不会报错，
 * 下一次 `list()` 重新解析路径时再尝试。
 */
function watchLibrary(roots, onChange, logger) {
  const watchers = []
  for (const root of roots) {
    try {
      watchers.push(watch(root, { recursive: true }, () => onChange()))
    } catch {
      // 目录不存在或不可监视：跳过，不影响注册。
    }
  }
  if (watchers.length === 0) return { dispose() {} }
  logger?.info?.(`dsh-magpie-skills: 已监视 ${watchers.length} 个技能库目录`)
  return {
    dispose() {
      for (const watcher of watchers) {
        try {
          watcher.close()
        } catch {
          // 已关闭：忽略。
        }
      }
    },
  }
}

/** 插件名（cordis 行名）。 */
export const name = 'dsh-magpie-skills'

/**
 * 不把 `skills` 写进顶层 `inject`：注册表缺失时整个插件会不加载，
 * 连日志都没有。用 `ctx.inject` 做增强项，缺了就只损失 `/` 里能选技能这一点。
 */
export const inject = []

/**
 * 插件入口。
 *
 * @param ctx    cordis 宿主上下文
 * @param config `{ dshHome?, magpieHome?, agent?, onlyApplied? }`
 */
export function apply(ctx, config = {}) {
  ctx.inject(['skills'], (skilled) => {
    let provider
    try {
      provider = createProvider(config, ctx.logger)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-magpie-skills: 构造 provider 失败：${String(error)}`)
      return
    }

    // 每个作用域各建一次 provider 工厂，控制句柄可能不止一个。
    const controls = new Set()
    let debounce
    const invalidateAll = () => {
      clearTimeout(debounce)
      debounce = setTimeout(() => {
        debounce = undefined
        for (const control of controls) {
          try {
            control.invalidate?.()
          } catch (error) {
            ctx.logger?.warn?.(`dsh-magpie-skills: 失效技能缓存失败：${String(error)}`)
          }
        }
      }, DEBOUNCE_MS)
    }

    try {
      skilled.skills.registerProvider((control) => {
        if (control !== undefined && control !== null) {
          controls.add(control)
          control.signal?.addEventListener('abort', () => controls.delete(control), { once: true })
        }
        return provider
      })
    } catch (error) {
      ctx.logger?.warn?.(`dsh-magpie-skills: 注册失败，/ 菜单将不含 magpie 技能：${String(error)}`)
      return
    }

    let watcher
    try {
      const { roots } = resolveLibraryPaths(config)
      watcher = watchLibrary(roots, invalidateAll, ctx.logger)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-magpie-skills: 无法监视技能库：${String(error)}`)
    }

    // 清理登记是增强项：拿不到 `effect` 也不该把已成功的注册变成一次加载失败。
    try {
      skilled.effect(() => () => {
        clearTimeout(debounce)
        watcher?.dispose()
        controls.clear()
      }, 'dsh-magpie-skills: provider + watcher')
    } catch (error) {
      ctx.logger?.warn?.(`dsh-magpie-skills: 登记清理句柄失败（不影响技能注册）：${String(error)}`)
    }

    // 启动时点一次名：装没生效最容易卡在「路径不对」，有这行日志就不用猜。
    const paths = (() => {
      try {
        return resolveLibraryPaths(config)
      } catch {
        return { roots: [], libraryJson: '' }
      }
    })()
    void provider
      .list()
      .then((found) => {
        const detail = found.length === 0
          ? '未发现技能（库可能为空，或技能只启用给了别的 agent）'
          : `发现 ${found.length} 条：${found.map((item) => item.name).join(', ')}`
        ctx.logger?.info?.(`dsh-magpie-skills: ${detail}（库：${paths.roots[0] ?? resolveDshHome(config)}）`)
      })
      .catch(() => {})
  })
}
