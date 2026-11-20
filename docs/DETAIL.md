# Thinking tree

Shows the current task's chain of thought as a live tree in the right sidebar, and keeps that tree on disk as Markdown so both the user and the agent work from the same files.

## What it adds

- **A button on the right edge of the window.** Clicking it opens the right Sidebar on the thinking-tree tab. The tab is also listed in the Sidebar's guide, so it can be opened from there.
- **A three-tier tree.** Depth is the tier: one root node is the goal, its children are the approach (what to do, what to download, which library or model implements it, the technical route, the style), and their children are the concrete steps (commands, files, endpoints, order).
- **Live updates.** While the panel is open it re-reads the folder about every 1.5 seconds, so nodes change as the agent writes them. Editing a node pauses the refresh until you save or cancel.
- **Edits that survive.** Markdown bodies are edited in the panel and saved straight back to the file. The status dot cycles pending → in progress → done → blocked, and adding a child node or deleting a node (with its descendants) also writes the folder.
- **A bundled skill** named `thinking-tree` that tells the agent the folder contract, when to build the tree, how to keep it updated while working, and that a user's edit outranks its own memory of the plan.

## Files on disk

Everything lives in one folder in the Session's workspace:

```
thinking-tree/
├── 00-goal.md
├── 01-tech-route.md
├── 01-1-write-host-route.md
└── 02-visual-style.md
```

One block is one `.md` file, all flatten in that folder. Front matter carries the structure:

```markdown
---
id: 01-tech-route
parent: 00-goal
order: 1
title: Technical route
status: active
updated: 2026-01-01T00:00:00.000Z
---

Markdown body.
```

`parent` alone decides the tree shape; the file name is only a reading convenience. Files starting with `_` are ignored by the panel and can hold human notes.

## Usage

1. Ask for something multi-step. The agent creates `thinking-tree/` and fills the goal, the route, and the steps.
2. Open the panel from the right-edge button and watch it fill in.
3. Change a route or add a constraint directly in the panel, save, and tell the agent to continue. It re-reads the folder before implementing and follows what is there.

## Limitations

- The tree is bound to the Session's workspace directory; a Session without a resolvable workspace shows an empty panel.
- The panel renders a Markdown subset (headings, lists, code spans and fences, quotes, emphasis, links). It does not render tables, images, or raw HTML.
- The tree is not part of the Session log: it is the files in the workspace. Forking a Session shares the same folder.
- Exactly one goal node is expected; extra roots are shown as additional top-level cards rather than being merged.