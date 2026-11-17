# dsh-magpie-skills

把 **magpie 技能库**接进 DeepSeek Harness 的技能注册表，让 magpie 面板里装好的技能
能在会话里用 `/` 选到、模型侧也能用 `skill` 工具加载。

## 为什么需要这个插件

magpie（`dsh-our-free-model` 内嵌的引擎）自带技能库：面板上加仓库、装技能、按 agent 启停。
但它和 DSH 自己的技能注册表是**两套互不相通的东西**：

| | magpie | DSH |
|---|---|---|
| 存什么 | 文件：`library/skills/<name>/SKILL.md` | 注册表：`ctx.skills` |
| 谁看得见 | magpie 面板 | 会话的 `/` 菜单、模型的 `skill` 工具 |
| 启停在 | `library.json` 的 `applied.<agent>.skills` | — |

两边之间缺一段**发现 + 注册**的代码。magpie 不提供（它只写文件），
`dsh-our-free-model` 也不代劳（它只负责跑引擎，不碰 `ctx.skills`）。
于是典型症状就是：**面板上技能显示「已启用」，在 DSH 里输入 `/` 却一条都匹配不到。**

这个插件补的就是那段：读技能库 → 按 `applied.dsh.skills` 筛 → 注册进 `ctx.skills`。

## 装什么，不装什么

- **不复制、不改写**技能文件。插件只读；技能正文每次加载时重读，磁盘上的改动立刻生效。
- **不停用**面板上的任何东西。面板里关掉的技能不会出现在 `/` 里，仅此而已。
- **不打包**其他依赖：解析 frontmatter 用自带的 YAML 子集解析器，不需要 `yaml` 包。

## 安装

插件以 DSH bundle 形式装载：

```bash
dsh plugin --profile <profile> add github:artorias-zj/dsh-magpie-skills
```

然后重启 DSH。也可以手动装：在 `<dshHome>/profiles/<profile>/package.json` 的
`dependencies` 里加 `"dsh-magpie-skills": "github:artorias-zj/dsh-magpie-skills"`，
在 `dsh.profile.bundles` 末尾加 `"dsh-magpie-skills"`，再在该目录执行 `pnpm install`。

## 技能库在哪

magpie 引擎由 `dsh-our-free-model` 以**独立 HOME** 启动（不污染真实用户目录），所以库落在：

```
<dshHome>/our-free-model/magpie/config/magpie/library/skills/<name>/SKILL.md   ← 权威
<dshHome>/our-free-model/magpie/config/magpie/library.json                      ← 启用记录
<dshHome>/our-free-model/magpie/agent-home/.dsh/skills/<name>                   ← 软链接视图
```

两个根都会被扫描，按 `realpath` 去重，同名技能不会出现两次。

## 哪些技能会出现在 `/` 里

1. `library.json` 的 `applied.dsh.skills` 里有它（按 frontmatter `name` 或目录名匹配）；
2. frontmatter 有合规的 `name`（`^[a-z0-9]+(-[a-z0-9]+)*$`）和非空 `description`；
3. 不是 `.disabled`；
4. `user-invocable` 不为 `false`。

`disable-model-invocation: true` 的技能**只**出现在 `/` 里（模型侧看不到）——
这正是只能手动触发的那一类，与官方语义一致。

`library.json` 缺失时（旧引擎或手写库）退化为「全部可见」：宁可多列，也不漏。

## 优先级

magpie 是外带库，rank 取 **600**，排在用户自己的技能之后：

```
项目 .dsh(100) → 项目 .agents(200) → 用户 .dsh(400) → 用户 .agents(500) → magpie(600)
```

所以 `~/.dsh/skills/<name>` 里放了同名技能时，那一份胜出，magpie 这份不会盖掉它。

## 配置

在装它的 cordis 行上可以覆盖：

| 键 | 默认 | 说明 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | DSH 主目录 |
| `magpieHome` | `<dshHome>/our-free-model/magpie` | magpie 数据目录（绝对路径） |
| `agent` | `dsh` | 读 `library.json` 里哪个 agent 的启用记录 |
| `onlyApplied` | `true` | 设 `false` 则忽略启用记录，库里所有技能都注册 |

## 热加载

装、删、启停技能后**不需要重启**：插件监视两个库根，fs 事件合并 250ms 后让注册表失效，
下一次目录刷新即可见。

## 目录

```
lib/index.js        入口：把提供方注册到 ctx.skills，并监视技能库
lib/library.js      定位技能库、套用启用记录、发现技能
lib/frontmatter.js  SKILL.md frontmatter 的 YAML 子集解析器
cordis.patch.yml    bundle 层：loader 行
```

没有构建步骤，也没有运行时依赖 —— 目录本身即可直接运行。

## 许可

MIT
