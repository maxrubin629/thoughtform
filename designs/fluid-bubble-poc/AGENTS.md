# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Durable design decisions

- This folder is a focused fluid-bubble behavior study, not the full mind-map interface.
- Use generic orange circular nodes on a quiet neutral canvas so motion and material behavior stay easy to judge.
- Joined nodes form smoothly fused visual necks while remaining distinct interactive objects. Proximity alone never creates or cuts a connection.
- Hovering a bubble reveals an icon-only join control. Clicking it arms that source; clicking a second bubble sends a fluid neck toward the target and joins them.
- Clicking an existing neck pops that connection with a visible fluid contraction and recoil animation.
- Connection necks flare broadly where they meet each bubble and narrow at their midpoint. Maximum attachment width is derived from the smaller node, with endpoint flare independently tunable.
- Connector side profiles must join each circular bubble tangentially through wide, filleted transitions—never as straight wedges or sharp joints. Expose both the fillet reach and the length of the slender central span as live controls.
- `designs/stem-.png` is the focused source of truth for connector anatomy: a slender center, opposing concave sides, and continuous curved blends into both bubbles.
- An actively dragged bubble is pinned directly to the pointer without spring lag or cursor-relative oscillation. Its connected neighbors still respond, and release visibly settles according to adjustable physics controls.
- The PoC must expose live material controls while keeping connection creation and removal intentional and legible.
- Saved connections behave like bidirectional springs around an equilibrium distance: compression repels and extension attracts. Repulsion and spring length remain independently tunable.
