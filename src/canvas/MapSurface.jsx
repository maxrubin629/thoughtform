import { useEffect, useRef } from "react";
import { IconCheck, IconLink, IconParking, IconPin, IconPinnedOff, IconPencil, IconPlus, IconQuote, IconSparkles, IconTrash, IconX } from "@tabler/icons-react";
import { canConnect, connectionBud, connectionPreviewPath } from "../connectionGesture.js";
import { clamp } from "./geometry.js";
import { palettes } from "./drawing.js";
import { IconButton } from "./IconButton.jsx";

const nodeLabel = (node) => node?.lines?.join(" ") ?? "Thought";

export function MapSurface({ props, refs, graph, view, gestures, shaderAvailable }) {
  const {
    concept, selectedId, selectedIds, edges, onSelect, onEdit, onAdd, onAskAI,
    onPin, onPark, onSources, controlsHidden = false, onArmConnect, onCancelConnect,
    onConnect, actionsNodeId, onActionsChange, rootId, onDelete, onAcceptGhost,
    onDismissGhost, connectFromId, zoom, pan, marqueeActive, lassoActive = false,
  } = props;
  const { shellRef, canvasRef, underlayCanvasRef, shaderCanvasRef } = refs;
  const { renderedNodes } = graph;
  const { viewport, transform } = view;
  const { marqueeRect, lassoPoints, hoveredNodeId, setHoveredNodeId, connectionPreview,
    suppressBudClickRef, beginConnection, hitNode, screenToWorld, handlePointerDown,
    handlePointerMove, handlePointerEnd, handleLostCapture, handlePointerLeave, handleDoubleClick } = gestures;
  const bubbleMenuRef = useRef(null);
  const palette = palettes[concept];
  useEffect(() => {
    if (!actionsNodeId && !connectFromId) return undefined;
    bubbleMenuRef.current?.querySelector('button:not(:disabled)')?.focus();
    const close = (event) => {
      if (!event.target.closest('.bubble-menu, [data-testid="thought-more-actions"], .connection-bud')) {
        onActionsChange(null);
        if (connectFromId) onCancelConnect();
      }
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [actionsNodeId, connectFromId, onActionsChange, onCancelConnect]);

  const selected = renderedNodes.find((node) => node.id === selectedId);
  const budNode = renderedNodes.find((node) => node.id === (connectionPreview?.sourceId ?? hoveredNodeId)) ?? selected;
  const bud = budNode && !budNode.ghost ? connectionBud(budNode, renderedNodes, transform, viewport) : null;
  const previewSource = renderedNodes.find((node) => node.id === connectionPreview?.sourceId);
  const previewTarget = renderedNodes.find((node) => node.id === connectionPreview?.targetId);
  const previewHit = connectionPreview ? hitNode(connectionPreview.point) : null;
  const connectionHint = previewTarget ? "Release to connect" : previewHit?.ghost ? "Accept this suggestion first" : previewHit && previewHit.id !== previewSource?.id ? "Already connected" : "Drag onto an existing thought";
  let previewEnd = connectionPreview?.point;
  if (previewSource && previewTarget) {
    const angle = Math.atan2(previewSource.y - previewTarget.y, previewSource.x - previewTarget.x);
    previewEnd = { x: previewTarget.x + Math.cos(angle) * previewTarget.r, y: previewTarget.y + Math.sin(angle) * previewTarget.r };
  }
  const menuNode = renderedNodes.find((node) => node.id === (connectFromId ?? actionsNodeId));
  const connectionTargets = renderedNodes.filter((node) => canConnect(connectFromId, node.id, renderedNodes, edges));
  const menuX = menuNode ? clamp(transform.offsetX + menuNode.x * transform.scale, 120, Math.max(120, viewport.width - 120)) : 0;
  const menuY = menuNode ? clamp(transform.offsetY + (menuNode.y + menuNode.r) * transform.scale + 18, 80, Math.max(80, viewport.height - 240)) : 0;
  const closeMenu = () => { onActionsChange(null); if (connectFromId) onCancelConnect(); };
  const menuAction = (action) => { closeMenu(); action(menuNode.id); };
  const actionX = selected
    ? clamp(transform.offsetX + (selected.x + selected.r - (selected.r > 100 ? 12 : 0)) * transform.scale, 94, viewport.width - 54)
    : 0;
  const actionY = selected
    ? clamp(transform.offsetY + selected.y * transform.scale, 116, viewport.height - 116)
    : 0;

  return (
    <div
      className={`map-shell ${marqueeActive ? "is-marquee" : ""} ${connectionPreview ? "is-connecting" : ""}`}
      ref={shellRef}
      data-selection-mode={marqueeActive ? (lassoActive ? "lasso" : "rectangle") : "none"}
      data-marquee-active={marqueeActive ? "true" : "false"}
      data-selected-count={selectedIds.length}
      data-zoom={zoom.toFixed(2)}
      data-pan-x={Math.round(pan.x)}
      data-pan-y={Math.round(pan.y)}
      data-material-renderer={concept === "paper" && shaderAvailable ? "webgl2" : "canvas2d"}
      data-connecting-from={connectionPreview?.sourceId ?? ""}
      data-connection-target={connectionPreview?.targetId ?? ""}
    >
      <canvas
        ref={underlayCanvasRef}
        className="map-underlay-canvas"
        aria-hidden="true"
      />
      <canvas
        ref={shaderCanvasRef}
        className={`material-shader-canvas ${concept === "paper" && shaderAvailable ? "is-active" : ""}`}
        aria-hidden="true"
      />
      <canvas
        ref={canvasRef}
        className="map-interaction-canvas"
        aria-label="Interactive organic idea map. Drag a thought to move it; drag its outer handle to connect it. Right-click or long-press a thought for actions. Double-click empty space to create a freeform thought. Use two fingers, a trackpad, or the empty canvas to pan."
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onLostPointerCapture={handleLostCapture}
        onPointerLeave={handlePointerLeave}
        onDoubleClick={handleDoubleClick}
        onContextMenu={(event) => {
          const hit = hitNode(screenToWorld(event.clientX, event.clientY));
          if (marqueeActive || controlsHidden || !hit || hit.ghost) return;
          event.preventDefault();
          onSelect(hit.id);
          onActionsChange(hit.id);
        }}
      />

      {previewSource && previewEnd && <svg className="connection-preview" viewBox={`0 0 ${viewport.width} ${viewport.height}`} aria-hidden="true" data-testid="connection-preview">
        <path transform={`translate(${transform.offsetX} ${transform.offsetY}) scale(${transform.scale})`} d={connectionPreviewPath(previewSource, previewEnd, transform.scale)} fill={palette.material} />
      </svg>}

      {connectionPreview && <div className="connection-drag-hint" role="status" style={{ left: clamp(transform.offsetX + connectionPreview.point.x * transform.scale, 160, Math.max(160, viewport.width - 160)), top: clamp(transform.offsetY + connectionPreview.point.y * transform.scale + 28, 80, viewport.height - 60) }}><IconLink /><span>{connectionHint}</span><kbd>esc</kbd></div>}

      {bud && !marqueeActive && !menuNode && !controlsHidden && <button
        type="button"
        className={`connection-bud ${connectionPreview ? "is-dragging" : ""}`}
        style={{ left: bud.x, top: bud.y }}
        data-testid="connection-bud"
        aria-label={`Connect from ${nodeLabel(budNode)}`}
        aria-describedby="connection-handle-help"
        aria-haspopup="menu"
        onPointerDown={(event) => beginConnection(event, budNode)}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onLostPointerCapture={handleLostCapture}
        onPointerEnter={() => setHoveredNodeId(budNode.id)}
        onPointerLeave={handlePointerLeave}
        onClick={(event) => {
          if (event.detail > 0 && suppressBudClickRef.current) return;
          onSelect(budNode.id);
          onArmConnect(budNode.id);
        }}
      ><span className="connection-bud-shape" aria-hidden="true"><IconLink stroke={1.7} /></span><span id="connection-handle-help" className="connection-handle-help" role="tooltip"><strong>Connect existing</strong><span>Drag to another thought</span></span></button>}

      {menuNode && !menuNode.ghost && !marqueeActive && <div
        ref={bubbleMenuRef}
        className="bubble-menu"
        role="menu"
        aria-label={connectFromId ? "Connect to a thought" : "Thought actions"}
        style={{ left: menuX, top: menuY }}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) closeMenu(); }}
        onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End", "Escape"].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Escape") { closeMenu(); window.requestAnimationFrame(() => shellRef.current?.querySelector('.connection-bud')?.focus()); return; }
          const items = [...event.currentTarget.querySelectorAll('button:not(:disabled)')];
          const index = items.indexOf(document.activeElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }}
      >
        {connectFromId ? <>
          <span className="bubble-menu-heading">Connect existing thought</span>
          {connectionTargets.map((node) => <button type="button" role="menuitem" key={node.id} onClick={() => { closeMenu(); onConnect(menuNode.id, node.id); }}>{nodeLabel(node)}</button>)}
          {!connectionTargets.length && <span className="bubble-menu-empty">{renderedNodes.filter((node) => !node.ghost).length < 2 ? "Add another thought to connect to." : "All visible thoughts are already connected to this one."}</span>}
          <button type="button" role="menuitem" onClick={closeMenu}><IconX />Cancel</button>
        </> : <>
          <button type="button" role="menuitem" data-testid="add-thought" onClick={() => menuAction(onAdd)}><IconPlus />New connected thought</button>
          <button type="button" role="menuitem" onClick={() => { onActionsChange(null); onArmConnect(menuNode.id); }}><IconLink />Connect existing…</button>
          <div className="bubble-menu-divider" role="separator" />
          <button type="button" role="menuitem" onClick={() => menuAction(onEdit)}><IconPencil />Edit thought</button>
          <button type="button" role="menuitem" data-testid="node-ai" onClick={() => menuAction(onAskAI)}><IconSparkles />Explore with Partner</button>
          <button type="button" role="menuitem" onClick={() => menuAction(onSources)}><IconQuote />View sources</button>
          <button type="button" role="menuitem" onClick={() => menuAction(onPin)}>{menuNode.pinned ? <IconPinnedOff /> : <IconPin />}{menuNode.pinned ? "Unpin position" : "Pin position"}</button>
          <button type="button" role="menuitem" onClick={() => menuAction(onPark)}><IconParking />{menuNode.parked ? "Bring thought back" : "Keep thought aside"}</button>
          <div className="bubble-menu-divider" role="separator" />
          <button type="button" role="menuitem" data-testid="delete-thought" className="danger-action" disabled={menuNode.id === rootId} onClick={() => menuAction(onDelete)}><IconTrash />Delete thought</button>
        </>}
      </div>}

      {lassoPoints.length > 1 && <svg className="lasso-overlay" viewBox={`0 0 ${viewport.width} ${viewport.height}`} aria-hidden="true" data-testid="lasso-outline">
        <polygon fillRule="evenodd" points={lassoPoints.map((point) => `${transform.offsetX + point.x * transform.scale},${transform.offsetY + point.y * transform.scale}`).join(" ")} />
      </svg>}

      {marqueeRect && (
        <div
          className="marquee-rectangle"
          data-testid="marquee-rectangle"
          style={marqueeRect}
          aria-hidden="true"
        />
      )}

      {renderedNodes.filter((node) => node.ghost).map((node) => (
        <button
          type="button"
          key={node.id}
          className="ghost-badge"
          style={{
            left: transform.offsetX + (node.x - node.r * 0.72) * transform.scale,
            top: transform.offsetY + (node.y + node.r * 0.58) * transform.scale,
          }}
          aria-label={`Review AI suggestion: ${nodeLabel(node)}`}
          title="Review AI suggestion"
          onClick={() => onSelect(node.id)}
        >
          <IconSparkles />
        </button>
      ))}

      {selected?.ghost && !marqueeActive && (
        <div
          className="node-actions ghost-actions"
          style={{ left: actionX, top: actionY }}
          onPointerDown={(event) => event.stopPropagation()}
        >
              <IconButton label="Accept AI suggestion" onClick={() => onAcceptGhost(selected.id)} testId="accept-suggestion">
                <IconCheck />
              </IconButton>
              <IconButton label="Dismiss AI suggestion" onClick={() => onDismissGhost(selected.id)} testId="dismiss-suggestion">
                <IconX />
              </IconButton>
        </div>
      )}
    </div>
  );
}
