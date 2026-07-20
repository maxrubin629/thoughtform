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

## Pearlescent liquid shader QA

### Comparison target

- Source visual truth for Paper material: `designs/pearlescent-liquid-paper.png`
- Implementation screenshot: `qa/pearlescent-paper-final.png`
- Reference viewport: 1487 × 1058
- State: Paper canvas, cluster view, root selected, WebGL2 material renderer active
- Full-view comparison evidence: `qa/pearlescent-paper-final-comparison.jpg`
- Focused material comparison evidence: `qa/pearlescent-paper-material-detail-comparison.jpg`
- Nocturne regression evidence: `qa/pearlescent-nocturne-regression-comparison.jpg`

### Fidelity findings

- No actionable P0, P1, or P2 differences remain.
- The reference governs material appearance only. Existing graph positions, lobe geometry, text, controls, and interaction anatomy intentionally remain unchanged.
- The connected committed Paper material now reads as one pearlescent liquid surface: broad top-left cream highlights continue through lobes and fused stems, coral body color stays legible behind text, and the paper contact shadow is soft rather than card-like.
- The multi-scale mask treatment removes visible shading seams at lobe/stem junctions while preserving the existing `Path2D` outline and hit-test geometry.
- Ghost proposals remain matte on the crisp 2D overlay, with tethers below the committed material. Selection rings, text, controls, and proposal copy receive no shader distortion.
- Paper typography, iconography, spacing, layout, and visible copy are unchanged from the existing design system. Nocturne continues to use its original Canvas2D material and dark chrome.

### Rendering and interaction verification

- Confirmed `data-material-renderer="webgl2"` in Paper and `data-material-renderer="canvas2d"` in Nocturne.
- Measured the ambient sheen across two captures 1.2 seconds apart; the mean absolute pixel delta stayed below 0.2 per RGB channel, making the motion visible but deliberately subtle.
- Enabled reduced motion and repeated the same capture test; the two screenshots were pixel-identical, confirming the ambient shader clock freezes.
- Dragged the root lobe through spring settling and confirmed fused necks stretch with continuous highlights and no geometry change.
- Panned and zoomed the live map, switched to hierarchy mode, created an unconnected freeform lobe, added a full long thought, and verified all text remained complete and crisp.
- Exercised rectangle selection and Escape cancellation; eleven lobes received exterior selection rings without changing shader geometry or canvas gesture ownership.
- Created a committed connection and popped it from the stem; growth, contact flare, rupture, and droplets all inherited the pearlescent material while preserving the existing causal clocks.
- Verified the Canvas2D initialization fallback directly with an unavailable WebGL2 context. Forced a live `WEBGL_lose_context` event as well: the app switched to Canvas2D during loss and returned to WebGL2 after restoration with no warning or error logs.
- Browser console warnings/errors after sustained interaction: none.

### Comparison history

- Initial finding: the first shader pass was too matte, the main highlight was too narrow, and the paper shadow was heavier than the selected pearlescent reference.
- Fix: raised diffuse fill, added a broader pearlescent shoulder around the top-left highlight, and softened contact-shadow opacity.
- Post-fix evidence: `qa/pearlescent-paper-final-comparison.jpg` and `qa/pearlescent-paper-material-detail-comparison.jpg`.
- P3: the generated reference uses painterly, non-deterministic micro-variation. The live procedural sheen is intentionally restrained so text and interaction feedback remain stable.

final result: passed

## Restrained 2.5D liquid material QA

### Comparison target

- Source visual truth for Paper material: `designs/organic-paper-studio.png`
- Initial implementation screenshot: `qa/flat-liquid-paper-initial.png`
- Reference viewport: 1487 × 1058
- State: Paper canvas, cluster view, root selected, WebGL2 flat-surface renderer active
- Initial full-view comparison evidence: `qa/flat-liquid-paper-initial-comparison.jpg`
- Focused comparison: not yet captured because the post-fix browser reload was blocked

### Findings

- [P2] Initial coral was too muted and brown relative to the prior Paper reference. The flat surface direction was correct, but the color lost the reference's warm coral clarity.
- [P2] The first undershadow was broader than the requested small contrast cue and made some lobes read as lifted objects rather than flat material.
- Typography, spacing, layout, iconography, copy, ghost proposals, and graph anatomy remained unchanged by scope. The initial browser capture showed no warning or error logs.

### Comparison history

- Initial fix applied: removed all normal-derived lighting, bright rims, specular highlights, subsurface variation, and ambient material animation while preserving the shared coverage texture and physical geometry.
- Follow-up fix applied: restored brighter coral channel balance and changed the shadow from a broad halo to a tighter, lower-opacity down-right undershadow.
- Motion-coherence refinement applied: added a separate local motion texture driven by the existing lobe velocity and deformation state. It produces only a faint warm stretched/leading edge and slightly darker compressed/trailing edge, fades with the physical motion, and is forced to zero under reduced motion. The resting shader still has no time input, normal-map lighting, rim, or internal highlight.
- Post-fix evidence is missing. The in-app browser rejected reload and screenshot access to the local-network preview URL after the follow-up change, so the final color and shadow adjustment could not be honestly compared.

### Verification status

- `npm run build` passes.
- `git diff --check` passes.
- Interaction code, physics constants, geometry, hit-testing, Nocturne rendering, ghost proposals, text, and controls were not changed. The only interaction-state additions are transient visual velocity fields used by the Paper shader.
- Blocking next check: capture the revised Paper canvas at rest and during a drag/settle at 1487 × 1058, compare the resting state with `designs/organic-paper-studio.png`, confirm the motion cue disappears fully at rest and under reduced motion, and rerun the interaction/console smoke test.

final result: blocked

## Uniform Paper material and conversation-first session QA

### Comparison targets

- Paper source visual truth: `designs/organic-paper-studio.png`
- Standard-mode implementation: `qa/session-port-standard.png`
- Session proposal review state: `qa/session-mode-proposal.png`
- Preview routes: `/` for the unchanged standard experience and `/?mode=session` for the conversation-first session

### Visual findings

- All committed Paper lobes and fused stems use the same original coral `#f78269`. The live Canvas2D fallback and WebGL2 coverage/albedo path no longer vary the base material by depth, horizontal position, or lobe size.
- The session curator uses the normal Paper proposal language: matte dashed coral ghost tethers on the canvas, a dashed warm ghost review surface, the same sparkle badge, and the same circular green accept / coral dismiss controls.
- The curator remains an internal orchestration role only. Proposal headers, accepted-proposal history, and all curator-authored activity entries render under the single user-facing identity `Partner`, using the same visual treatment as realtime-partner activity.
- Session bubbles reuse the Paper material, geometry, physics, text renderer, node actions, zoom controls, and fused-stem interactions. The standard route remains the existing application.
- Follow-up evidence: `qa/session-sidebar-kept.png`. The expanded shared Paper rail remains, while the rejected extra ghost-lobe layer was removed; session proposals are again limited to direct matte ghost tethers plus the evidence review card.

### Session contract verification

- Committed a multi-clause utterance and confirmed the transcript retained the complete text while condensation produced three bubbles with exact contiguous character spans.
- Repeated an existing idea and confirmed its bubble warmed and enlarged without a duplicate; the reversible map history and activity record attributed that revision to `partner`.
- Selected one bubble and confirmed provenance marked only that bubble's recorded source span inside the full utterance.
- Started voice capture and observed partial words only in the live caption; no transcript or map entry appeared until the complete voice turn committed.
- Generated curator proposals, confirmed rationale, transcript evidence, and source map revision were present, then accepted a two-link proposal and confirmed the links used the requested 160 ms stagger. Undo removed the map change without changing the transcript; redo remained available.
- Proposal rebasing drops missing endpoints, already-live links, self-links, and reversed duplicates; an empty rebase reports the proposal as stale.
- Static contract checks confirmed condensation never exceeds three ideas, stored spans round-trip to the source text, bubble radius is independent of label length, and duplicate proposal operations collapse to one valid operation.
- Production build and `git diff --check` pass. The live browser console contains no warnings or errors after standard and session interaction passes.

final result: passed
