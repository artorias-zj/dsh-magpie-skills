# dsh-magpie-skills

Bridge the **magpie skill library** into DeepSeek Harness's skill registry, so skills you
installed in the magpie panel show up in the session `/` menu and can be loaded by the
model's `skill` tool.

## Why this plugin exists

magpie (the engine embedded in `dsh-our-free-model`) ships its own skill library: add a
repo, install skills, toggle them per agent. But it and DeepSeek Harness's skill registry
are **two unrelated things**:

| | magpie | DSH |
|---|---|---|
| stores | files: `library/skills/<name>/SKILL.md` | the registry: `ctx.skills` |
| visible in | the magpie panel | the session `/` menu, the `skill` tool |
| enable/disable | `applied.<agent>.skills` in `library.json` | — |

What is missing between them is a piece of **discover + register** code. magpie does not
provide it (it only writes files), and `dsh-our-free-model` does not either (it runs the
engine and never touches `ctx.skills`). The symptom is therefore typical: **the panel says
the skill is enabled, yet typing `/` in DSH matches nothing.**

This plugin supplies exactly that piece: read the library, filter by
`applied.dsh.skills`, register into `ctx.skills`.

## What it does, and does not

- **No copying, no rewriting.** The plugin only reads; skill bodies are re-read on every
  load, so on-disk edits apply immediately.
- **No toggling behind the panel's back.** A skill switched off in the panel simply does
  not appear in `/`.
- **No extra dependencies.** frontmatter is parsed by a bundled YAML-subset parser, so no
  `yaml` package is needed.

## Install

The plugin loads as a DSH bundle. In the profile directory:

```bash
# 1) add it to the profile: in package.json dependencies
#      "dsh-magpie-skills": "file:D:/Project/DSH/dsh-magpie-skills"
#    and append "dsh-magpie-skills" to dsh.profile.bundles
cd ~/.dsh/profiles/desktop
pnpm install

# 2) restart DSH
```

## Where the library lives

`dsh-our-free-model` starts the magpie engine with an **isolated HOME** (so it never
rewrites a real agent's files), which puts the library at:

```
<dshHome>/our-free-model/magpie/config/magpie/library/skills/<name>/SKILL.md   ← canonical
<dshHome>/our-free-model/magpie/config/magpie/library.json                      ← enablement
<dshHome>/our-free-model/magpie/agent-home/.dsh/skills/<name>                   ← symlink view
```

Both roots are scanned and de-duplicated by `realpath`, so a skill never appears twice.

## Which skills appear in `/`

1. `applied.dsh.skills` in `library.json` lists it (matched by frontmatter `name` or
   directory name);
2. its frontmatter has a valid `name` (`^[a-z0-9]+(-[a-z0-9]+)*$`) and a non-empty
   `description`;
3. it is not `.disabled`;
4. `user-invocable` is not `false`.

A skill with `disable-model-invocation: true` appears **only** in `/` (the model cannot
see it) — exactly the user-only class, matching official semantics.

With no `library.json` (older engine, hand-built library) it degrades to "everything
visible": better to over-list than to hide.

## Precedence

magpie is an external library, so it registers at rank **600**, after the user's own skills:

```
project .dsh(100) → project .agents(200) → user .dsh(400) → user .agents(500) → magpie(600)
```

If `~/.dsh/skills/<name>` holds a skill of the same name, that one wins and magpie's copy
does not shadow it.

## Configuration

Override on the cordis row that loads it:

| key | default | meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME` or `~/.dsh` | DSH home |
| `magpieHome` | `<dshHome>/our-free-model/magpie` | magpie data dir (absolute) |
| `agent` | `dsh` | which agent's enablement record to read |
| `onlyApplied` | `true` | `false` ignores enablement and registers every skill |

## Hot reload

Installing, removing or toggling a skill needs no restart: both roots are watched, fs
events coalesce for 250 ms, then the registry is invalidated and the next listing sees it.

## Layout

```
lib/index.js        entry: registers the provider on ctx.skills, watches the library
lib/library.js      locates the library, applies enablement, discovers skills
lib/frontmatter.js  YAML-subset parser for SKILL.md frontmatter
cordis.patch.yml    bundle layer: the loader row
```

No build step and no runtime dependencies — the directory runs as-is.

## License

MIT
