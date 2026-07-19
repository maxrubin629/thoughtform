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
- Spacing and layout rhythm: the user-refined 60 px left rail, expanded 316 px top dock, left-weighted root, right-growing branches, review badges, microphone, and zoom cluster preserve the source composition while accommodating the rectangle-selection tool.
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
- Verified the native wheel path produces exact canvas pan deltas with stable page metrics; source-checked cursor-anchored canvas zoom and centroid-anchored two-touch distance zoom.
- Dragged and released a leaf lobe; confirmed lab-matched inertia, motion deformation, linked spring recovery, unrelated-lobe repulsion, web clearance, damping, and edge bounds.
- Exercised the 0.8-1.2x neutral spring band directly: linked nodes inside the band stayed force-free, stretched links restored, and overlapping unrelated lobes repelled.
- Verified every ghost proposal tether is constructed exterior-to-exterior, reaches both outlines with explicit endpoint dots, and leaves no interior segment or loop at any proposal angle.
- Verified the workspace rail resolves to the shared 60 px token, with desktop and compact panel offsets derived from that same value.
- Connected a descendant back to the root, entered Focus mode, and confirmed the cyclic graph returns immediately instead of freezing.
- Confirmed committed connection mode ignores ghost proposals and creates no invisible edge or false success state.
- Captured a complete voice thought and confirmed its entire sentence remains visible in a content-sized lobe with a recording timer that starts at zero.
- Hid AI proposals, added a manual thought, and confirmed the proposal layer remained hidden.
- Switched a runtime proposal into hierarchy view and confirmed live-parent placement, stable rows, and clearance from the top dock and microphone cluster.
- Verified simultaneous listening and connection guidance have non-overlapping bounding boxes.
- Verified Nocturne uses the floating rail, lower-left companion prompt, root glow, and consistently dark panel controls without Paper-card leakage.
- Added a new child and inspected frame-synchronous diagnostics for the source, traveling head, exterior contact, and final fused neck. The shared renderer now reaches contact at 294 ms and expands into the final flare through 420 ms, so accepted proposals and manual joins use the same continuous material transition.
- Recorded an off-center connection pop at animation speed. The membrane pinches at the exact click point, the rupture and droplets travel toward both exterior anchors, the nearer endpoint reacts first, and each endpoint's surviving stems deform on the same arrival frame as its lobe. Dragging from the same stem still pans without popping it.
- Recorded an armed manual connection from launch through impact. The source lobe ripples along the stem axis on the first growth frame, the target remains undeformed until exterior contact at 294 ms, and the target compresses directionally while the head widens into the final flare. A smaller reverse impulse reaches the source 72 ms after contact while its existing stems follow the same deformation.
- Re-recorded the new-child flow after changing the shared renderer; the lobe appeared, the narrow head reached it, and the final attachment widened over multiple rendered frames without a one-frame geometry swap.
- Double-clicked an empty canvas region and confirmed a selected, unconnected `New thought` lobe appeared at the clicked world position. Repeated the gesture on an existing lobe and a committed stem; the lobe opened its editor, the stem retained its pop behavior, and neither spawned an extra thought.
- Activated rectangle selection from the Paper top dock, captured the visible 250 × 185 px drag box before pointer release, and confirmed five intersecting lobes received exterior selection rings while the single-node action rail stayed hidden.
- Deleted those five selected lobes in one action and confirmed the history contained exactly one `Removed 5 selected thoughts` entry. One Undo restored the complete selected branch and re-enabled Redo; the deletion path filters both endpoints of every attached edge.
- Repeated rectangle selection at 116% zoom with canvas pan `(50, 40)`. The same five intended lobes were selected while zoom and pan remained unchanged, confirming screen-to-world selection geometry under the live transform.
- Selected the starting thought by itself and confirmed the contextual status read `starting thought protected`, the deletable count stayed at zero, and the trash action was disabled.
- Pressed Escape after a transformed selection and confirmed the active tool, selection set, drag box, and contextual toolbar all cleared without resetting the 116% zoom or `(50, 40)` pan.
- Double-clicked empty canvas while rectangle selection was active and confirmed map history remained only `Opened map`; after exiting the mode, the same gesture created and selected `New thought` and added one `Added a freeform thought` history entry.
- Repeated the selection pass in Nocturne and confirmed the active tool lives in its floating rail, the contextual toolbar uses the dark panel surface, and the same five selected lobes use the luminous exterior ring treatment.
- Inspected the supplied 120 Hz recording frame by frame and confirmed the reported shake was a two-frame rewind: adjacent frames differed sharply while frames two apart nearly matched. Added and then moved a connected lobe into a crowded region after the fix; the graph advanced toward rest without alternating layouts, and the console remained clear.
- Browser console warnings/errors checked after the final build: none.

## Comparison history

### Iteration 1

- Finding: the previous prototype used approximated connector geometry, a flatter field, and incomplete tool behavior compared with the selected Paper Studio mock.
- Fix: rebuilt the editor around the `fluid-bubble-lab` material model, matched the source node positions and control chrome, added real paper texture, and implemented the full core interaction surface.

### Iteration 2

- Finding: the first full comparison showed muted coral material, slightly narrow bridge waists, and a microphone pulse that was too faint.
- Fix: reduced material texture blending, tuned the lab bridge width, restored the source coral saturation, and strengthened the pulse rings.
- Post-fix evidence: `qa/paper-ui-final.png`, `qa/paper-ui-comparison.jpg`, and `qa/paper-ui-focus-comparison.jpg`.

### Iteration 3

- Finding: new lobes still popped, but their stems were committed at full length on the first frame, removing the lab's source-to-target arrival.
- Fix: restored the lab's pending-head travel, fusion pulse, and 520 ms timing at the shared material-renderer layer; connection timestamps now cover new thoughts, accepted proposals, and manual joins.

### Iteration 4

- Finding: connection removal faded the whole membrane while both endpoint lobes began a generic wobble immediately; future-scheduled wobble states were also clamped into a visible pre-shake.
- Fix: moved the pop to one shared 520 ms clock, mapped the click to the visible membrane span, propagated a split and particles outward from that origin, and scheduled each endpoint deformation for its actual rupture-arrival time.

### Iteration 5

- Finding: manually connecting two existing lobes assigned both endpoints the same wobble immediately, so the target reacted before the traveling stem reached it and the source motion did not read as launch recoil.
- Fix: keyed both reactions to the edge's creation timestamp, constrained the pending head to first meet the target exterior on the 520 ms arrival frame, and used the lab's smaller directional source pulse at launch plus stronger directional target compression on contact.

### Iteration 6

- Finding: the source reacted at launch but received no return impulse after target contact, while the traveling head remained separate for too long and then swapped to a fully flared bridge in one frame.
- Fix: shortened growth to 420 ms, moved exterior contact to 70% of that clock, expanded the contact head continuously into the target during the final 30%, and scheduled a smaller reverse-direction source impulse 72 ms after target impact.

### Iteration 7

- Finding: double-clicking empty canvas space only cleared selection because the handler recognized existing lobes but had no freeform creation branch.
- Fix: added world-coordinate freeform creation with no parent edge, selected the new lobe immediately, exited branch focus so it remains visible, and guarded the gesture against lobes, proposals, armed-connection mode, committed stems, and recent stem-pop locations.

### Iteration 8

- Finding: the canvas only supported one selected lobe, so removing several related thoughts required repeated actions and repeated history entries.
- Fix: added an explicit marquee mode with transform-correct intersection testing, selected-lobe rings, a root-aware bulk trash action, one-step graph/history deletion, and deterministic Escape cancellation without changing ordinary canvas gesture arbitration.

### Iteration 9

- Finding: at high refresh rates, the physics loop could advance its node ref and then have a lagging React effect overwrite it with an older committed snapshot, producing a rapid two-layout oscillation after node creation or movement.
- Fix: made physics and graph actions the sole writers of the authoritative node and edge refs. React state remains the rendered mirror and can no longer rewind a newer simulation frame.

## Follow-up polish

- P3: the source image contains small, naturally irregular paint variations that are not deterministic in the live canvas. The implemented paper grain and fused geometry preserve the intended material character without compromising interaction clarity.

final result: passed
