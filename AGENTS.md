# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Durable design decisions

- The map uses solid circular lobes connected by thick, smoothly fused organic necks. Never substitute rectangular cards, generic bubbles, or thin connector lines.
- Large starting ideas sit left-ish and children progress primarily to the right; crowded branches can wrap above, below, and sideways.
- Controls should communicate through familiar icons instead of word buttons wherever possible.
- Voice capture uses a circular microphone state with a timer or pulse. Do not introduce a scrolling waveform.
- The two selected visual targets are `designs/organic-paper-studio.png` and `designs/nocturne-focus-canvas.png`.
- Voice capture creates a node only after a complete spoken thought; do not continuously rewrite the graph from partial speech.
- AI additions, connections, and restructures must appear as ghost proposals with explicit accept/reject controls. Never silently mutate accepted nodes.
- Cluster and hierarchy modes are switchable views of one underlying graph, not separate documents.
- AI presence can switch between quiet and proactive without leaving the canvas. Provenance stays hidden by default but can be revealed.
- The solo-first result is a clear thinking map plus a written synthesis, stored as a local-first artifact; it is not an action-plan generator.
- Nodes remain distinct and draggable while their fused necks visually stretch and pull with them.
- Canvas navigation uses two-finger trackpad scrolling and two-touch centroid panning. Pinch gestures zoom; one-pointer dragging on empty canvas remains available.
- Map motion follows `sites/fluid-bubble-lab`: Jelly defaults, creation-time rest lengths, a 0.8-1.2x neutral spring band, lobe and web clearance, damped release inertia, and soft edge collisions.
- Ghost-proposal tethers must be constructed from explicit exterior boundary anchors on both rendered shapes, with control handles that keep the path outside both interiors. Render the tether beneath solid material, use round dots with anchored endpoints, and never target either shape's center.
- The workspace rail is a 60 px shared layout token; floating-panel offsets must derive from the same token at every breakpoint.
- Complete thoughts are lossless: never truncate captured or typed text. Expand the lobe from content length and fit the full thought legibly inside it.
- Graph focus traversal must be cycle-safe. Pending ghost proposals cannot receive committed connections until they are accepted.
- Hierarchy mode uses the live graph, distributes proposal siblings outside their parent, reserves the fixed top and voice-control chrome, and does not run cluster spring physics.
- Manual and voice thoughts preserve the user's proposal-layer visibility choice; only creating a new AI proposal may reveal that layer.
- Nocturne uses its own floating tool rail, dark panel surfaces, lower-left companion prompt, and luminous root treatment rather than inheriting Paper chrome.
- Newly committed stems use a 420 ms two-phase growth: the head reaches the target exterior at 70%, then widens continuously into the final target flare through the remaining 30%. Reduced-motion mode may reveal the completed connection immediately.
- The canvas keeps its grab cursor over lobes, empty space, and fused stems. Clicking a committed stem pops and removes that connection with the lab's 520 ms burst; dragging from the same stem pans instead.
- Connection-pop motion has one causal clock and a visible origin: the rupture begins at the exact click point, travels toward both endpoints, and each endpoint lobe plus its surviving stems deform only when that wave reaches them. Never start both endpoint wobbles generically at click time.
- Armed connection growth has one causal clock: the source lobe ripples directionally at launch, the target compresses in the direction of travel when the head contacts its exterior, and a smaller reverse impulse returns to the source 72 ms later. Attached stems inherit each lobe's deformation, and the contact flare must grow continuously rather than snap on.
- Double-clicking genuinely empty canvas space creates and selects an unconnected freeform `New thought` lobe at that world position. Double-clicks on lobes, proposals, committed stems, or controls must never spawn another lobe.
- Rectangle selection is an explicit canvas mode: Paper exposes it in the top dock and Nocturne in its floating rail. The drag box intersects lobes in world coordinates, selected lobes keep their organic form with an exterior selection ring, and Escape exits the mode and clears the set.
- Rectangle selection owns one-pointer canvas gestures while active, so it never drags lobes, pans, pops stems, edits, or creates freeform thoughts. Bulk deletion preserves the root, removes every edge attached to deleted lobes, and records the whole removal as one undo step.
