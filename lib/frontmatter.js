/**
 * dsh-magpie-skills —— SKILL.md frontmatter 解析。
 *
 * magpie 技能库里的 SKILL.md 用的是标准 YAML frontmatter，但写法比官方技能更花：
 * drawio-skill 有 `disable-model-invocation: true` 和一行内联 JSON 的 `metadata`，
 * storage-analyzer 的 `description` 用折叠块标量 `>` 跨十几行。用单行正则取值会把
 * `>` 本身当成描述（现有插件就是这么写的，遇到折叠块就失效），所以这里实现一个小而
 * 正确的 YAML 子集解析器：标量、引号、块标量、布尔。
 *
 * 不引入 `yaml` 依赖：插件要能在零安装目录里直接跑，多一个依赖就多一处装不上的可能。
 *
 * @module dsh-magpie-skills/frontmatter
 */

/** 切出 `---` 包裹的 frontmatter 与正文；CRLF 归一为 LF。 */
export function splitFrontmatter(raw) {
  const text = String(raw).replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  if ((lines[0] ?? '').trim() !== '---') return undefined
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      return { yamlText: lines.slice(1, i).join('\n'), body: lines.slice(i + 1).join('\n') }
    }
  }
  return undefined
}

/** 去掉包裹的引号。 */
function unquote(value) {
  const match = /^(['"])([\s\S]*)\1$/.exec(value)
  return match ? match[2] : value
}

/** 标量取值：布尔 / 数字 / 引号字符串 / 原样。 */
function coerce(value) {
  const text = value.trim()
  if (text === '') return ''
  if (/^['"]/.test(text)) return unquote(text)
  const lower = text.toLowerCase()
  if (lower === 'true' || lower === 'yes' || lower === 'on') return true
  if (lower === 'false' || lower === 'no' || lower === 'off') return false
  if (/^-?\d+$/.test(text)) return Number(text)
  return text
}

/** 收集块标量正文，到第一个缩进归零的非空行为止。 */
function readBlock(lines, start) {
  const block = []
  let baseIndent = -1
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      block.push('')
      i += 1
      continue
    }
    const indent = line.length - line.trimStart().length
    if (indent === 0) break
    if (baseIndent < 0) baseIndent = indent
    block.push(line.slice(Math.min(indent, baseIndent)))
    i += 1
  }
  while (block.length > 0 && block[block.length - 1] === '') block.pop()
  return { block, next: i }
}

/**
 * 解析 frontmatter 的 YAML 子集。
 *
 * 只取顶层 key —— 嵌套的 `metadata` 是给别的客户端看的，DSH 用不到，
 * 因此不实现嵌套映射（嵌套行会被当作未知内容跳过，而不是解析出错）。
 */
export function parseYamlSubset(yamlText) {
  const lines = String(yamlText).replace(/\r\n?/g, '\n').split('\n')
  const out = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      i += 1
      continue
    }
    const indent = line.length - line.trimStart().length
    if (indent !== 0) {
      i += 1
      continue
    }
    const match = /^([^\s:#][^:]*):(.*)$/.exec(line)
    if (match === null) {
      i += 1
      continue
    }
    const key = match[1].trim()
    const rest = match[2]

    const block = /^\s*([>|])([+-]?)\s*$/.exec(rest)
    if (block !== null) {
      const { block: body, next } = readBlock(lines, i + 1)
      // `|` 原样保留换行；`>` 折叠：相邻非空行用空格连，空行留作换行。
      let value
      if (block[1] === '|') {
        value = body.join('\n')
      } else {
        value = ''
        for (const part of body) {
          if (part === '') {
            value += '\n'
            continue
          }
          if (value !== '' && !value.endsWith('\n')) value += ' '
          value += part
        }
      }
      out[key] = block[2] === '-' ? value : value + '\n'
      i = next
      continue
    }

    let value = rest.trim()
    // 纯量尾部注释（引号内的不算）。
    if (!/^['"]/.test(value)) value = value.replace(/\s+#.*$/, '')
    out[key] = coerce(value)
    i += 1
  }
  return out
}

/** 宽松布尔：接受布尔本身与 yes/no/on/off/1/0 拼写。 */
export function looseBoolean(value) {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase()
    if (lower === 'true' || lower === 'yes' || lower === 'on') return true
    if (lower === 'false' || lower === 'no' || lower === 'off') return false
  }
  return undefined
}

/**
 * 解析一份 SKILL.md。
 *
 * @returns `{ name, description, whenToUse, modelInvocable, userInvocable, body }`；
 *          frontmatter 缺失时返回 `undefined`。
 */
export function parseSkillFile(raw) {
  const split = splitFrontmatter(raw)
  if (split === undefined) return undefined
  const data = parseYamlSubset(split.yamlText)

  const name = typeof data.name === 'string' ? data.name.trim() : ''
  const description = typeof data.description === 'string' ? data.description.trim() : ''
  const whenToUse = typeof data['when-to-use'] === 'string' ? data['when-to-use'].trim() : ''
  // 与官方语义一致：`disable-model-invocation` 为真即「仅用户可调用」——
  // 正是只能从 `/` 进入的那一类。`user-invocable` 显式为假才移出 `/`。
  return {
    name,
    description,
    ...(whenToUse === '' ? {} : { whenToUse }),
    modelInvocable: looseBoolean(data['disable-model-invocation']) !== true,
    userInvocable: looseBoolean(data['user-invocable']) !== false,
    body: split.body,
  }
}
