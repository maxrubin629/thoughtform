# Design QA

## Comparison target

- Source visual truth: `designs/organic-paper-studio.png`
- Implementation screenshot: `qa/paper-ui-final.png`
- Viewport: 1487 × 1058, matching the source image exactly
- State: Paper canvas, root selected, three AI proposals visible, microphone idle
- Full-view comparison evidence: `qa/paper-ui-comparison.jpg`
- Focused-region comparison evidence: `qa/paper-ui-focus-comparison.jpg`

## Fidelity findings

- No actionable P0, P1, or P2 differences remain.
- Fonts and typography: Manrope 400/500/600 is bundled locally and used in both DOM controls and the high-DPI canvas. Root wrapping, node hierarchy, timer, and ghost labels align with the reference.
- Spacing and layout rhythm: the user-refined 60 px left rail, 270 px top dock, left-weighted root, right-growing branches, review badges, microphone, and zoom cluster preserve the source composition.
- Colors and visual tokens: the pale blue paper field, warm ivory controls, coral material, charcoal type, and restrained coral proposal outlines match the selected Paper Studio direction. Material texture was reduced after comparison so the coral retains the source saturation.
- Metaball anatomy: the implementation uses the geometry and growth logic adapted from `sites/fluid-bubble-lab/app/BubblePrototype.jsx`, including crowd-aware attachment angles, per-endpoint radii, tapered Bezier necks, and directional placement. The Paper target uses a tuned bridge width while preserving that material model.
- Asset quality: the paper grain is a generated raster asset at `src/assets/paper-texture.png`; controls use Tabler icons. There are no emoji, text-glyph icons, handcrafted SVGs, placeholder boxes, or CSS-drawn substitute assets.
- Copy and content: all visible node labels, timer copy, proposal copy, and tool hierarchy match the source state.

## Interaction verification

- Dragged lobes on the canvas and confirmed movement in map history.
- Opened search, filtered to “AI as creative partner,” and selected the result.
- Generated an AI ghost branch, reviewed it, and accepted it.
- Submitted a custom AI prompt through the form and confirmed a new reviewable ghost branch.
- Started and finished voice capture and confirmed a node is created only at the completed-thought boundary.
- Added a thought manually through the composer; a browser pass caught and fixed the form-submit button behavior.
- Switched between cluster and hierarchy views of the same graph.
- Toggled proposal visibility off and back on.
- Opened map switcher, profile, synthesis overview, layers, settings, and history.
- Verified zoom, center, undo, and redo.
- Verified horizontal and vertical two-finger trackpad panning in the live preview.
- Verified the two-touch centroid gesture path moves the whole canvas without dragging a lobe.
- Dragged and released a leaf lobe; confirmed lab-matched inertia, motion deformation, linked spring recovery, unrelated-lobe repulsion, web clearance, damping, and edge bounds.
- Exercised the 0.8-1.2x neutral spring band directly: linked nodes inside the band stayed force-free, stretched links restored, and overlapping unrelated lobes repelled.
- Verified every ghost proposal tether is constructed exterior-to-exterior, reaches both outlines with explicit endpoint dots, and leaves no interior segment or loop at any proposal angle.
- Verified the workspace rail resolves to the shared 60 px token, with desktop and compact panel offsets derived from that same value.
- Browser console warnings/errors checked after the final build: none.

## Comparison history

### Iteration 1

- Finding: the previous prototype used approximated connector geometry, a flatter field, and incomplete tool behavior compared with the selected Paper Studio mock.
- Fix: rebuilt the editor around the `fluid-bubble-lab` material model, matched the source node positions and control chrome, added real paper texture, and implemented the full core interaction surface.

### Iteration 2

- Finding: the first full comparison showed muted coral material, slightly narrow bridge waists, and a microphone pulse that was too faint.
- Fix: reduced material texture blending, tuned the lab bridge width, restored the source coral saturation, and strengthened the pulse rings.
- Post-fix evidence: `qa/paper-ui-final.png`, `qa/paper-ui-comparison.jpg`, and `qa/paper-ui-focus-comparison.jpg`.

## Follow-up polish

- P3: the source image contains small, naturally irregular paint variations that are not deterministic in the live canvas. The implemented paper grain and fused geometry preserve the intended material character without compromising interaction clarity.

final result: passed
