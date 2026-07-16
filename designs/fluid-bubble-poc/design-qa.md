# Design QA

## Comparison target

- Source visual truth: `../organic-paper-studio.png`
- Focused connector source: `../stem-.png`
- Browser-rendered implementation: `qa/final.png`
- Revised connector implementation: `qa/final-stem-geometry.png`
- Browser capture viewports: 1422 × 800 for the full comparison; 1013 × 986 for the focused revised implementation
- States: default Jelly material with six bubbles and five links in the full view; responsive compact state with five bubbles and four links in the focused connector view
- Full-view comparison evidence: `qa/comparison.png`
- Focused connector comparison evidence: `qa/stem-comparison.png`. This directly compares the concave side profiles, narrow central span, and filleted bubble transitions against `stem-.png`.

## Findings

- No actionable P0, P1, or P2 differences remain for the requested interaction-study scope.
- Fonts and typography: bundled Manrope is used for both the material controls and canvas labels. Generic node copy is intentionally shorter than the product mock so the motion remains easy to judge.
- Spacing and layout rhythm: the canvas dominates the frame and the tuning panel stays visible beside it at the desktop comparison viewport. The reduced six-node topology intentionally isolates the material behavior rather than reproducing the complete map.
- Colors and visual tokens: the warm orange nodes, warm neutral canvas, dark brown text, rounded panels, and restrained borders preserve the selected paper concept's visual family without copying its entire app chrome.
- Image quality and asset fidelity: the source reference is preserved as a raster asset. The interactive material is rendered at device-pixel-ratio resolution on canvas; there are no placeholder images or substitute decorative assets.
- Copy and content: controls name the physical properties they alter, values update visibly, and the current settings remain copyable for later implementation work.
- Accessibility and interaction: controls use semantic icon buttons with accessible names and named range inputs. Hover-to-arm, target selection, animated join completion, neck popping, cursor-pinned drag/release, material presets, scene reset, and spring compression/rebound were exercised in the browser. Browser console warnings/errors checked: none.

## Comparison history

### Iteration 1

- Earlier P1 behavior: saved spring links and ambient proximity attraction competed, causing the graph to fold into a dense clump after resting.
- Fix: proximity attraction now acts only around the actively dragged bubble, while saved links own their equilibrium behavior.
- Post-fix evidence: `qa/final-rest.png` and `qa/final.png`.

### Iteration 2

- Earlier P1 behavior: the spring model did not make the compression/extension balance explicit enough to tune.
- Fix: saved links now use radial Hooke-style forces around a stored equilibrium distance; compression repels, extension attracts. Added independent Repulsion and Spring length controls and presets.
- Post-fix evidence: `qa/spring-compressed.png`, `qa/spring-rebound.png`, and `qa/final.png`.

### Iteration 3

- Earlier P1 interaction: connection creation lived in a toolbar mode and proximity attraction visually implied that bringing bubbles together could alter topology. Dragging also followed the cursor with a spring, so the active bubble could oscillate around the pointer.
- Fix: every bubble now exposes an icon-only join control on hover. It arms that source, the next bubble click animates a fluid neck toward the target, and clicking an existing neck removes it with a contraction, droplets, and recoil. Proximity no longer creates or cuts links. The actively dragged node is pinned to the pointer while connected neighbors retain spring behavior. Join-state evidence: `qa/join-growing.png`.
- Earlier P1 visual: bridge geometry did not guarantee a narrow midpoint or make endpoint flare independently tunable.
- Fix: every bridge now uses two cubic halves around a narrow waist; both attachment widths are capped from the smaller node radius, and Endpoint flare is a dedicated live control.
- Post-fix evidence: `qa/final.png` and `qa/comparison.png`.

### Iteration 4

- Earlier P1 usability issue: the hover join control disappeared as the pointer crossed from the canvas onto the button because the canvas-level leave handler cleared the hovered bubble.
- Fix: hover ownership now clears only when the pointer leaves the entire stage. The join button also sits slightly farther inside the bubble edge, so it remains continuously reachable. Browser verification confirmed the control stays in the DOM under the pointer and clicking it arms the source bubble.
- Earlier P1 visual issue: connector sides tapered as straight wedges and met the bubbles at visible angular joints, unlike the tangential, filleted web in `../stem-.png`.
- Fix: connector attachment points now derive circle tangents at both ends. Each side follows that tangent into an opposing concave cubic profile, holds a tunable slender central span, and mirrors the transition into the target bubble. Added live Fillet reach and Slender span controls alongside Neck width and Endpoint flare.
- Post-fix evidence: `qa/final-stem-geometry.png` and `qa/stem-comparison.png`.

## Implementation checklist

- [x] Fluid orange bubbles and fused visual necks
- [x] Cursor-pinned pointer dragging with viscous deformation and release motion
- [x] Bidirectional spring equilibrium for saved links
- [x] Independent short-range repulsion
- [x] Explicit hover-to-arm and click-to-join connection flow
- [x] Animated fluid neck growth and click-to-pop removal
- [x] Narrow-waist bridges with smaller-node-capped endpoint flare
- [x] Tangential, filleted joins with opposing concave side profiles
- [x] Independent Fillet reach and Slender span controls
- [x] Hover join control remains clickable across the canvas-to-button transition
- [x] Add, delete, connect, disconnect, and reset interactions
- [x] Live material sliders, presets, and copyable settings
- [x] Responsive desktop and narrow layouts
- [x] Production build and browser interaction verification

## Follow-up polish

- P3: very long cross-canvas links intentionally remain more strand-like than local links. Neck width, Endpoint flare, and Spring length are exposed for the next tuning pass rather than hard-coding one material response.

final result: passed
