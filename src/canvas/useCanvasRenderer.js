import { useEffect, useMemo, useRef, useState } from "react";
import paperTextureUrl from "../assets/paper-texture.png";
import { BASE_WIDTH, BASE_HEIGHT } from "./viewport.js";
import { CONNECTION_CREATE_DURATION, PAPER_MATERIAL_SETTINGS, buildFluidVisualNodes, clamp, drawFluidConnectionPop, drawFluidMaterial } from "../fluidMaterial.js";
import { createFluidShaderRenderer } from "../fluidShaderRenderer.js";
import { palettes, drawGhostTether, drawHoverGlow, drawSelectionContour, drawWobblyCircle, drawWrappedText } from "./drawing.js";

export function useCanvasRenderer(
  { canvasRef, underlayCanvasRef, shaderCanvasRef },
  { renderedNodes, renderedEdges },
  { viewport, transform },
  { hoveredNodeId, connectionPreview },
  { poppingConnectionsRef, connectionIsPopping },
  { concept, reducedMotion, marqueeActive, selectedIds, showProvenance },
) {
  const shaderRendererRef = useRef(null);
  const materialRasterRef = useRef(null);
  const motionRasterRef = useRef(null);
  const textureRef = useRef(null);
  const [fontReady, setFontReady] = useState(false);
  const [textureReady, setTextureReady] = useState(false);
  const [shaderAvailable, setShaderAvailable] = useState(false);
  const palette = palettes[concept];
  const materialColor = (node) => concept === "paper"
    ? palette.material
    : palette.materialByDepth[clamp(node.depth ?? 0, 0, palette.materialByDepth.length - 1)];
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  useEffect(() => {
    Promise.all([
      document.fonts.load("400 22px Manrope"),
      document.fonts.load("500 15px Manrope"),
    ]).then(() => setFontReady(true));
    const image = new Image();
    image.onload = () => {
      textureRef.current = image;
      setTextureReady(true);
    };
    image.src = paperTextureUrl;
  }, []);

  useEffect(() => {
    if (concept !== "paper" || !shaderCanvasRef.current) {
      shaderRendererRef.current?.dispose();
      shaderRendererRef.current = null;
      setShaderAvailable(false);
      return undefined;
    }

    const renderer = createFluidShaderRenderer(shaderCanvasRef.current, {
      onAvailabilityChange: setShaderAvailable,
    });
    shaderRendererRef.current = renderer;
    setShaderAvailable(Boolean(renderer?.available));

    return () => {
      renderer?.dispose();
      if (shaderRendererRef.current === renderer) shaderRendererRef.current = null;
      setShaderAvailable(false);
    };
  }, [concept]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const underlayCanvas = underlayCanvasRef.current;
    if (!canvas || !underlayCanvas) return undefined;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    [canvas, underlayCanvas].forEach((layer) => {
      layer.width = Math.round(viewport.width * dpr);
      layer.height = Math.round(viewport.height * dpr);
      layer.style.width = `${viewport.width}px`;
      layer.style.height = `${viewport.height}px`;
    });
    const ctx = canvas.getContext("2d");
    const underlayCtx = underlayCanvas.getContext("2d");
    const renderer = shaderRendererRef.current;
    const paperShaderActive = concept === "paper" && shaderAvailable && renderer?.available;
    const shaderDpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let materialCtx = null;
    let motionCtx = null;
    if (paperShaderActive) {
      renderer.resize(viewport.width, viewport.height, shaderDpr);
      if (!materialRasterRef.current) materialRasterRef.current = document.createElement("canvas");
      if (!motionRasterRef.current) motionRasterRef.current = document.createElement("canvas");
      const materialRaster = materialRasterRef.current;
      const motionRaster = motionRasterRef.current;
      [materialRaster, motionRaster].forEach((raster) => {
        if (
          raster.width !== shaderCanvasRef.current.width
          || raster.height !== shaderCanvasRef.current.height
        ) {
          raster.width = shaderCanvasRef.current.width;
          raster.height = shaderCanvasRef.current.height;
        }
      });
      materialCtx = materialRaster.getContext("2d");
      motionCtx = motionRaster.getContext("2d");
    }
    let frame = 0;
    let materialDirty = true;
    let wasAnimating = false;

    const clearLayer = (context, layer) => {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, layer.width, layer.height);
    };

    const beginWorld = (context, ratio) => {
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.save();
      context.translate(transform.offsetX, transform.offsetY);
      context.scale(transform.scale, transform.scale);
    };

    const drawTethers = (context, visualNodes) => {
      renderedEdges.filter((edge) => edge.ghost).forEach((edge) => {
        const from = visualNodes.get(edge.from);
        const to = renderedNodes.find((node) => node.id === edge.to);
        if (from && to) drawGhostTether(context, from, to, edge.bend ?? 0, palette.ghost);
      });
    };

    const drawRevisitGlow = (context, visualNodes, now) => {
      if (reducedMotion) return;
      visualNodes.forEach((node) => {
        if (node.ghost || node.heatAt == null) return;
        const progress = clamp((now - node.heatAt) / 900, 0, 1);
        if (progress <= 0 || progress >= 1) return;
        const alpha = Math.sin(progress * Math.PI) * 0.16;
        const radius = Math.max(node.radiusX, node.radiusY) * (1.08 + progress * 0.12);
        const glow = context.createRadialGradient(
          node.x,
          node.y,
          Math.max(node.radius * 0.82, 1),
          node.x,
          node.y,
          radius,
        );
        glow.addColorStop(0, `rgba(247, 130, 105, ${alpha})`);
        glow.addColorStop(1, "rgba(247, 130, 105, 0)");
        context.fillStyle = glow;
        context.beginPath();
        context.arc(node.x, node.y, radius, 0, Math.PI * 2);
        context.fill();
      });
    };

    const drawCommittedMaterial = (context, visualNodes, now) => {
      const materialEdges = renderedEdges.filter((edge) => !connectionIsPopping(edge, now));
      drawFluidMaterial(context, visualNodes, materialEdges, {
        color: palette.material,
        colorForNode: materialColor,
        now,
        reducedMotion,
        settings: PAPER_MATERIAL_SETTINGS,
      });
    };

    const applyPaperGrain = (context) => {
      if (!textureRef.current) return;
      const pattern = context.createPattern(textureRef.current, "repeat");
      if (!pattern) return;
      context.save();
      context.globalCompositeOperation = "source-atop";
      context.globalAlpha = 0.035;
      context.fillStyle = pattern;
      context.fillRect(0, 0, BASE_WIDTH, BASE_HEIGHT);
      context.restore();
    };

    const drawConnectionPops = (context, visualNodes, now) => {
      poppingConnectionsRef.current = poppingConnectionsRef.current.filter((pop) => {
        const progress = clamp((now - pop.start) / pop.duration, 0, 1);
        if (progress >= 1) return Boolean(pop.hideUntilResolved);
        const a = visualNodes.get(pop.aId) ?? pop.a;
        const b = visualNodes.get(pop.bId) ?? pop.b;
        const fill = context.createLinearGradient(a.x, a.y, b.x, b.y);
        fill.addColorStop(0, materialColor(a));
        fill.addColorStop(1, materialColor(b));
        drawFluidConnectionPop(context, a, b, PAPER_MATERIAL_SETTINGS, pop, progress, fill);
        return true;
      });
    };

    const drawMotionField = (context, visualNodes) => {
      visualNodes.forEach((node) => {
        if (node.ghost || node.motionShadeStrength <= 0) return;
        const strength = clamp(node.motionShadeStrength, 0, 1);
        const red = Math.round(clamp(node.motionShadeX * 0.5 + 0.5, 0, 1) * 255);
        const green = Math.round(clamp(node.motionShadeY * 0.5 + 0.5, 0, 1) * 255);
        const radius = Math.max(node.radiusX, node.radiusY) * 1.72;
        const centerAlpha = Math.min(0.82, strength * 0.9);
        const field = context.createRadialGradient(
          node.x,
          node.y,
          Math.max(node.radius * 0.18, 1),
          node.x,
          node.y,
          radius,
        );
        field.addColorStop(0, `rgba(${red}, ${green}, 255, ${centerAlpha})`);
        field.addColorStop(0.58, `rgba(${red}, ${green}, 255, ${centerAlpha * 0.72})`);
        field.addColorStop(1, `rgba(${red}, ${green}, 255, 0)`);
        context.fillStyle = field;
        context.beginPath();
        context.arc(node.x, node.y, radius, 0, Math.PI * 2);
        context.fill();
      });
    };

    const drawGhostsSelectionAndText = (context, visualNodes) => {
      renderedNodes.filter((node) => node.ghost).forEach((node) => {
        drawWobblyCircle(context, node);
        context.fillStyle = palette.ghostFill;
        context.fill();
        context.setLineDash([4, 4]);
        context.lineWidth = 1.5;
        context.strokeStyle = palette.ghost;
        context.stroke();
        context.setLineDash([]);
      });

      renderedNodes.forEach((node) => {
        if (!selectedIdSet.has(node.id)) return;
        const visual = visualNodes.get(node.id) ?? node;
        drawSelectionContour(context, visual, concept, transform.scale);
      });

      renderedNodes.forEach((node) => {
        const visual = visualNodes.get(node.id) ?? node;
        drawWrappedText(context, node, visual.x, visual.y, palette, showProvenance);
      });
    };

    const hasMaterialAnimation = (now) => (
      (!reducedMotion && renderedNodes.some((node) => (
        (node.createdAt != null && now - node.createdAt < 900)
        || (node.heatAt != null && now - node.heatAt < 900)
        || (node.wobbleEndAt != null && now < node.wobbleEndAt + 80)
      )))
      || (!reducedMotion && renderedEdges.some((edge) => (
        edge.createdAt != null && now - edge.createdAt < CONNECTION_CREATE_DURATION + 80
      )))
      || poppingConnectionsRef.current.some((pop) => now < pop.start + pop.duration)
    );

    const draw = (now) => {
      const animatingBeforeDraw = hasMaterialAnimation(now);
      const needsFinalMaterialFrame = wasAnimating && !animatingBeforeDraw;

      clearLayer(ctx, canvas);
      clearLayer(underlayCtx, underlayCanvas);

      const visualNodes = buildFluidVisualNodes(renderedNodes, now, reducedMotion);
      if (concept === "paper") {
        beginWorld(underlayCtx, dpr);
        drawTethers(underlayCtx, visualNodes);
        drawRevisitGlow(underlayCtx, visualNodes, now);
        const hoveredNode = visualNodes.get(connectionPreview?.targetId ?? hoveredNodeId);
        if (hoveredNode && !marqueeActive) {
          drawHoverGlow(underlayCtx, hoveredNode, concept, transform.scale);
        }

        if (paperShaderActive) {
          underlayCtx.restore();
          if (materialDirty || animatingBeforeDraw || needsFinalMaterialFrame) {
            clearLayer(materialCtx, materialRasterRef.current);
            clearLayer(motionCtx, motionRasterRef.current);
            beginWorld(materialCtx, shaderDpr);
            drawCommittedMaterial(materialCtx, visualNodes, now);
            applyPaperGrain(materialCtx);
            drawConnectionPops(materialCtx, visualNodes, now);
            materialCtx.restore();
            beginWorld(motionCtx, shaderDpr);
            drawMotionField(motionCtx, visualNodes);
            motionCtx.restore();
            renderer.update(materialRasterRef.current, motionRasterRef.current);
          }
          renderer.render();
        } else {
          drawCommittedMaterial(underlayCtx, visualNodes, now);
          applyPaperGrain(underlayCtx);
          drawConnectionPops(underlayCtx, visualNodes, now);
          underlayCtx.restore();
        }

        beginWorld(ctx, dpr);
        drawGhostsSelectionAndText(ctx, visualNodes);
        ctx.restore();
      } else {
        beginWorld(ctx, dpr);
        drawTethers(ctx, visualNodes);
        const root = visualNodes.get("root");
        if (root) {
          const halo = ctx.createRadialGradient(root.x, root.y, root.r * 0.72, root.x, root.y, root.r * 1.48);
          halo.addColorStop(0, "rgba(255, 112, 82, 0.22)");
          halo.addColorStop(0.58, "rgba(255, 94, 68, 0.09)");
          halo.addColorStop(1, "rgba(255, 78, 55, 0)");
          ctx.fillStyle = halo;
          ctx.beginPath();
          ctx.arc(root.x, root.y, root.r * 1.48, 0, Math.PI * 2);
          ctx.fill();
        }
        const hoveredNode = visualNodes.get(connectionPreview?.targetId ?? hoveredNodeId);
        if (hoveredNode && !marqueeActive) {
          drawHoverGlow(ctx, hoveredNode, concept, transform.scale);
        }
        drawCommittedMaterial(ctx, visualNodes, now);
        drawConnectionPops(ctx, visualNodes, now);
        drawGhostsSelectionAndText(ctx, visualNodes);
        ctx.restore();
      }

      materialDirty = false;
      const animatingAfterDraw = hasMaterialAnimation(now);
      wasAnimating = animatingAfterDraw;
      if (animatingAfterDraw) {
        frame = window.requestAnimationFrame(draw);
      }
    };

    frame = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(frame);
  }, [
    concept,
    connectionPreview,
    fontReady,
    hoveredNodeId,
    marqueeActive,
    palette,
    reducedMotion,
    renderedEdges,
    renderedNodes,
    selectedIdSet,
    shaderAvailable,
    showProvenance,
    textureReady,
    transform,
    viewport,
  ]);

  return shaderAvailable;
}
