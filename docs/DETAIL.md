# Thinking tree

Draws the current task's chain of thought as a live mind map in the right sidebar, and keeps that map on disk as Markdown so the user and the agent read the same files.

## What it adds

- **A pill on the right edge of the window.** Clicking it opens the right Sidebar on the thinking-tree tab. The tab is also offered as a card in the Sidebar's guide.
- **A mind map, not a list.** The goal sits at the left, requirements branch to the right, and their approach and steps continue outward, joined by curved links. The wheel zooms around the pointer; the left or middle button drags the canvas; holding the left button on a block moves that block and stores its coordinates in the file.
- **Tiers by depth.** Depth 0 is the goal, depth 1 is what the user asked for, depth 2 is the technical route, deeper nodes are concrete steps. Labels on each block show `GOAL` / `REQ` / `ROUTE` / `STEP`.
- **Editable blocks.** Clicking a block opens a drawer with the node's title, its Markdown body, a model picker, and save / add child / delete (two clicks, deletes the subtree). A small ▾ appears when the text was cut, and right-clicking a block expands or collapses it in place.
- **A self-check loop.** The panel's `Self-check` button writes `selfcheck: on` into the goal node and wakes the agent. Every turn that ends then starts another verification round — the agent must prove each requirement, mark failures `blocked`, keep working, and only clear the flag when everything is evidenced — up to 40 rounds, after which the loop stops and the node records why.
- **A model per block.** Each block may name `model: provider/model`; the drawer's picker is filled from the Host's real model catalog, and the block's corner shows the chosen model. Empty means "inherit"; the skill tells the agent to delegate that block's work to a subagent on that route.
- **Live updates.** While the panel is open it re-reads the folder about every 1.5 seconds, so blocks change as the agent writes them. Editing a block pauses the refresh until you save or close.
- **A bundled skill** named `thinking-tree` that tells the agent the folder contract, when to build the map, how to keep it current while working, that a user's edit outranks its own memory, and that node text stays plain work notes with no filler.

## Files on disk

Everything lives in one folder in the Session's workspace:

```
thinking-tree/
├── 00-goal.md
├── 01-req-panel.md
├── 01-1-route.md
└── 02-req-tree.md
```

One block is one `.md` file, all flat in that folder. Front matter carries the structure:

```markdown
---
id: 01-req-panel
parent: 00-goal
order: 1
title: Right-edge button opens the panel
status: active
updated: 2026-01-01T00:00:00.000Z
---

Plain work notes.
```

`parent` alone decides the tree shape; the file name is only a reading convenience. Files starting with `_` are ignored by the panel. A dragged block also carries `x:` and `y:`, which pin it until **Auto layout** clears them.

## Usage

1. Ask for something multi-step. The agent creates `thinking-tree/` with the goal, the requirements, and their routes.
2. Open the panel from the right-edge pill and watch the map fill in.
3. Change a requirement or a route in the panel, save, and tell the agent to continue. It re-reads the folder before implementing.

## Limitations

- The tree is bound to the Session's workspace directory; a Session without a resolvable workspace shows an empty panel.
- Blocks are placed automatically unless dragged; moving a parent does not move its subtree, so links stretch.
- The panel shows titles plus one body line; the full Markdown is in the drawer.
- The tree is not part of the Session log: it is the files in the workspace, so a forked Session shares the same folder.
- Exactly one goal node is expected; extra roots are drawn as additional top-level blocks.