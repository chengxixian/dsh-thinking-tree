# dsh-thinking-tree

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that shows the current task's **chain of thought as a tree** in the right sidebar, and keeps that tree on disk as one Markdown file per block.

English | [中文](README.zh.md)

![icon](icon.svg)

## What it looks like

```
┌ 右侧边栏 ─────────────────────────┐
│ ● 做一个树形思考链插件        [目标] │   ← 最上面：目标
│   实时显示、可编辑、md 落盘          │
│   ├ ● 技术路线：Host 路由 + 技能  [路线] │   ← 中间：路线
│   │   用什么实现、怎么验证            │
│   │   ├ ● 写 /api/thinking-tree  [步骤] │   ← 最下面：具体做什么
│   │   └ ● 面板轮询 1.5s          [步骤] │
│   └ ● 视觉风格：跟随主题 token   [路线] │
└──────────────────────────────────┘
```

A slim button sits on the right edge of the window. Clicking it opens the right Sidebar on the thinking-tree tab; the tab is also offered in the Sidebar guide.

The tree is not a chat transcript. It is a folder:

```
<workspace>/thinking-tree/
├── 00-goal.md                 → 目标
├── 01-tech-route.md           → 路线
├── 01-1-host-route.md         → 步骤
└── 02-visual-style.md         → 路线
```

`parent` in each file's front matter decides the shape; file names are for humans. Depth *is* the tier: depth 0 is the goal, depth 1 is the approach, depth 2 and deeper are the concrete steps.

## Why a folder of files

- **The user can edit the plan.** Every block is plain Markdown in the panel: click a card, change the text, save. Status cycles pending → in progress → done → blocked. Add a child, delete a subtree.
- **The agent reads the same thing.** A bundled skill (`thinking-tree`) tells it to build the tree at the start of a multi-step task, to keep updating it while it works, and — the important part — to **re-read the folder before implementing and follow the user's edits instead of its own memory of the plan**.
- **The panel is live.** It re-reads the folder about every 1.5 seconds while open, so the tree grows as the agent writes. Editing pauses the refresh.

## Install

Requirements: a DeepSeek Harness installation whose Web UI runs the right Sidebar (`@deepseek-ai/dsh-client-ui-sidebar-right`).

1. **Plugins → Add plugin**, and pick this directory (or the cloned repo).
2. Enable the `thinking-tree` bundle if it is not enabled yet.
3. Open a Session, click the button on the right edge of the window.

From an agent session you can also install the local directory with the `plugin_manager` tool:

```json
{ "action": "install_bundle", "target": "C:\\path\\to\\dsh-thinking-tree" }
```

## Usage

1. Ask for something multi-step. The agent creates `thinking-tree/`, writes the goal, two to six approach nodes, and the steps under them.
2. Open the panel and watch it fill in while the agent works.
3. Disagree with a route? Edit it in the panel, save, and tell the agent to continue. It re-reads the folder and follows your version.
4. Start it yourself when the agent has not: the empty panel has a "create goal" field.

## Node file format

```markdown
---
id: 01-tech-route
parent: 00-goal
order: 1
title: Technical route: host route + skill
status: active
updated: 2026-01-01T00:00:00.000Z
---

# Technical route

Body Markdown. Everything below the front matter is yours to write.
```

| Field | Meaning |
|---|---|
| `id` | Stable identity inside the tree. Defaults to the file name without `.md`. Do not rename it after other nodes point at it. |
| `parent` | The `id` of the parent node; empty (or `null`) marks a root. |
| `order` | Sibling sort key, ascending. |
| `title` | Card title. Falls back to the first heading, then the file name. |
| `status` | `pending` · `active` · `done` · `blocked`. |
| `updated` | ISO timestamp; the panel rewrites it on every save. |

Files whose name starts with `_` are ignored by the panel, so `_index.md` is a fine place for human notes.

## How it is built

| File | Role |
|---|---|
| `index.js` | Host half: registers the bundled skill provider and five JSON routes (`tree`, `save`, `create`, `status`, `delete`) on the Connection layer under `/api/thinking-tree`. Resolves the Session's workspace from its header. |
| `client.js` | Browser half: registers the `thinking-tree` right-Sidebar tab type, its body, and the right-edge button in `shell.overlay`. Renders a Markdown subset, edits nodes, polls for changes. |
| `assets/thinking-tree/SKILL.md` | The skill body the agent loads. |
| `locale/*.json` | Plugin Manager title, description, detail page. |
| `docs/DETAIL.md` | The detail page shown in Plugin Manager. |

Nothing is cached on the Host: each request re-reads the folder, so the files really are the single source of truth.

## Limitations

- Bound to the Session's workspace directory; a Session without a resolvable workspace shows an empty panel.
- The Markdown renderer covers headings, lists, code spans and fences, blockquotes, emphasis, and links — not tables, images, or raw HTML.
- The tree is not part of the Session log. A forked Session shares the same folder.
- One goal node is expected; additional roots are rendered as extra top-level cards.

## License

MIT