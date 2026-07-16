# Design QA

## Comparison targets

- Paper source visual truth: `designs/organic-paper-studio.png`
- Nocturne source visual truth: `designs/nocturne-focus-canvas.png`
- Paper implementation screenshot: `qa/paper-final.png`
- Nocturne implementation screenshot: `qa/nocturne-final.png`
- Viewport: 1440 × 1024
- State: default map, root selected, AI suggestions visible, microphone idle
- Full-view comparison evidence: `qa/paper-comparison.jpg` and `qa/nocturne-comparison.jpg`
- Focused-region comparison: not needed. The source and implementation are normalized to the same viewport and the selected root, fused branch geometry, node copy, icon controls, microphone, and zoom cluster remain readable at original resolution in the full-view comparisons.

## Findings

- No actionable P0, P1, or P2 differences remain.
- Fonts and typography: Manrope 400/500/600 is bundled locally and now renders consistently inside both the DOM controls and canvas. The hierarchy, short labels, and root wrapping match the selected concepts.
- Spacing and layout rhythm: the left-weighted parent, right-growing child hierarchy, upper/lower crowding behavior, sparse tool chrome, microphone placement, and zoom placement align with both targets at 1440 × 1024.
- Colors and visual tokens: paper uses pale blue, warm ivory, coral, and charcoal; nocturne uses ink navy, warm coral, and cream. Ghost suggestions use restrained dashed coral outlines in both.
- Image quality and asset fidelity: the map is rendered as an interactive high-DPI canvas at the device pixel ratio. Controls use the Tabler icon library; no placeholder imagery, custom inline SVG, emoji, or text-glyph icons are present.
- Copy and content: the node hierarchy, suggestion copy, transcript prompt, timer, and control purposes match the selected concept content.
- Accessibility and interaction: icon buttons have accessible names, visible focus states, and hover states. Voice start/stop, zoom, add child, and AI suggestion visibility were tested successfully. Browser console warnings/errors checked: none.

## Comparison history

### Iteration 1

- Earlier findings: P1 canvas text briefly rendered with a fallback serif; P1 connector strokes looked too rigid compared with the fused organic reference.
- Fixes made: delayed the canvas redraw until bundled Manrope was available; replaced uniform strokes with continuous organic bridge geometry beneath the circular lobes.
- Post-fix evidence: `qa/paper-revised.png` and `qa/nocturne-revised.png`.

### Iteration 2

- Earlier finding: P2 bridge profiles remained too uniform and linear around dense branch junctions.
- Fix made: tapered bridge necks, widened node flares, and increased the controlled bends for near-horizontal relationships.
- Post-fix evidence: `qa/paper-final.png`, `qa/nocturne-final.png`, `qa/paper-comparison.jpg`, and `qa/nocturne-comparison.jpg`.

## Follow-up polish

- P3: the generated references contain softer paper grain and diffuse atmospheric glow than the coded canvas. These are non-blocking finish details and do not change hierarchy, interaction, or the defining organic map language.

## Implementation checklist

- [x] Faithful organic fused-circle hierarchy
- [x] Parent-left and children-right spatial behavior
- [x] Crowded branches use upper, lower, and side space
- [x] Icon-first controls
- [x] Circular microphone state with no waveform
- [x] Paper and nocturne visual systems
- [x] Primary interactions tested
- [x] Production build passes

final result: passed
