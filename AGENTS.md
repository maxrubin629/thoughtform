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
- Newly committed stems grow from source to target with the lab's 520 ms pending-head motion. Reduced-motion mode may reveal the completed connection immediately.
- The canvas keeps its grab cursor over lobes, empty space, and fused stems. Clicking a committed stem pops and removes that connection with the lab's 520 ms burst; dragging from the same stem pans instead.
