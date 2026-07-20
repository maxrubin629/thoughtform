const FULLSCREEN_VERTEX_SHADER = `#version 300 es
precision highp float;

out vec2 vUv;

void main() {
  vec2 position;
  if (gl_VertexID == 0) position = vec2(-1.0, -1.0);
  else if (gl_VertexID == 1) position = vec2(3.0, -1.0);
  else position = vec2(-1.0, 3.0);
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const BLUR_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uTexture;
uniform vec2 uTexel;
uniform float uRadius;

in vec2 vUv;
out vec4 outColor;

void main() {
  vec2 cardinal = uTexel * uRadius;
  vec2 diagonal = cardinal * 0.72;
  vec4 color = texture(uTexture, vUv) * 0.22;
  color += texture(uTexture, vUv + vec2(cardinal.x, 0.0)) * 0.12;
  color += texture(uTexture, vUv - vec2(cardinal.x, 0.0)) * 0.12;
  color += texture(uTexture, vUv + vec2(0.0, cardinal.y)) * 0.12;
  color += texture(uTexture, vUv - vec2(0.0, cardinal.y)) * 0.12;
  color += texture(uTexture, vUv + diagonal) * 0.075;
  color += texture(uTexture, vUv - diagonal) * 0.075;
  color += texture(uTexture, vUv + vec2(diagonal.x, -diagonal.y)) * 0.075;
  color += texture(uTexture, vUv + vec2(-diagonal.x, diagonal.y)) * 0.075;
  outColor = color;
}
`;

const MATERIAL_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uSource;
uniform sampler2D uSoft;
uniform sampler2D uBroad;
uniform sampler2D uMotion;
uniform vec2 uResolution;
uniform vec2 uSoftTexel;

in vec2 vUv;
out vec4 outColor;

void main() {
  vec4 source = texture(uSource, vUv);
  float coverage = source.a;
  float depthTone = smoothstep(0.5, 0.69, source.g);
  vec3 flatColor = source.rgb + vec3(
    mix(0.15, 0.10, depthTone),
    mix(-0.065, 0.025, depthTone),
    mix(-0.025, 0.02, depthTone)
  );
  flatColor = clamp(flatColor, 0.0, 1.0);

  vec4 motion = texture(uMotion, vUv);
  float motionStrength = motion.a;
  vec2 motionDirection = vec2(
    motion.r * 2.0 - 1.0,
    1.0 - motion.g * 2.0
  );
  float motionLength = length(motionDirection);
  if (motionStrength > 0.001 && motionLength > 0.001 && coverage > 0.001) {
    motionDirection /= motionLength;
    float softLeft = texture(uSoft, vUv - vec2(uSoftTexel.x, 0.0)).a;
    float softRight = texture(uSoft, vUv + vec2(uSoftTexel.x, 0.0)).a;
    float softDown = texture(uSoft, vUv - vec2(0.0, uSoftTexel.y)).a;
    float softUp = texture(uSoft, vUv + vec2(0.0, uSoftTexel.y)).a;
    vec2 edgeNormal = vec2(softLeft - softRight, softDown - softUp);
    float edgeLength = length(edgeNormal);
    if (edgeLength > 0.0001) edgeNormal /= edgeLength;

    float innerEdge = clamp((coverage - texture(uSoft, vUv).a) * 4.8, 0.0, 1.0);
    float response = innerEdge * motionStrength;
    float directionalSide = dot(edgeNormal, motionDirection);
    float stretchedSide = max(directionalSide, 0.0) * response;
    float compressedSide = max(-directionalSide, 0.0) * response;
    flatColor += vec3(1.0, 0.49, 0.31) * stretchedSide * 0.055;
    flatColor *= 1.0 - compressedSide * 0.045;
    flatColor = clamp(flatColor, 0.0, 1.0);
  }

  vec2 shadowOffset = vec2(-3.5 / max(uResolution.x, 1.0), 4.5 / max(uResolution.y, 1.0));
  float shiftedSoft = texture(uSoft, vUv + shadowOffset).a;
  float broad = texture(uBroad, vUv + shadowOffset * 0.72).a;
  float shadow = max(shiftedSoft * 0.82 + broad * 0.18 - coverage, 0.0);
  shadow = smoothstep(0.018, 0.58, shadow) * 0.105;
  vec3 shadowColor = vec3(0.34, 0.23, 0.19);

  float materialAlpha = coverage;
  float shadowAlpha = shadow * (1.0 - materialAlpha);
  float finalAlpha = materialAlpha + shadowAlpha;
  if (finalAlpha < 0.001) discard;

  vec3 finalColor = (
    flatColor * materialAlpha
    + shadowColor * shadowAlpha
  ) / max(finalAlpha, 0.001);
  outColor = vec4(finalColor, finalAlpha);
}
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "Unknown shader compilation error";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl, fragmentSource) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "Unknown shader link error";
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function createTexture(gl) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

function bindTexture(gl, texture, unit, uniform) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(uniform, unit);
}

export function createFluidShaderRenderer(canvas, options = {}) {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    depth: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
    stencil: false,
  });
  if (!gl) return null;

  let available = false;
  let disposed = false;
  let resources = null;
  let sourceCanvas = null;
  let motionCanvas = null;
  let pixelWidth = 1;
  let pixelHeight = 1;

  const notifyAvailability = (next) => {
    if (available === next) return;
    available = next;
    options.onAvailabilityChange?.(next);
  };

  const deleteResources = () => {
    if (!resources || gl.isContextLost()) {
      resources = null;
      return;
    }
    [resources.source, resources.motion, resources.softA.texture, resources.softB.texture,
      resources.broadA.texture, resources.broadB.texture].forEach((texture) => gl.deleteTexture(texture));
    [resources.softA.framebuffer, resources.softB.framebuffer,
      resources.broadA.framebuffer, resources.broadB.framebuffer].forEach((framebuffer) => gl.deleteFramebuffer(framebuffer));
    gl.deleteProgram(resources.blurProgram);
    gl.deleteProgram(resources.materialProgram);
    gl.deleteVertexArray(resources.vertexArray);
    resources = null;
  };

  const createTarget = () => ({
    texture: createTexture(gl),
    framebuffer: gl.createFramebuffer(),
    width: 1,
    height: 1,
  });

  const initializeResources = () => {
    deleteResources();
    const blurProgram = createProgram(gl, BLUR_FRAGMENT_SHADER);
    const materialProgram = createProgram(gl, MATERIAL_FRAGMENT_SHADER);
    const vertexArray = gl.createVertexArray();
    resources = {
      blurProgram,
      materialProgram,
      vertexArray,
      source: createTexture(gl),
      motion: createTexture(gl),
      softA: createTarget(),
      softB: createTarget(),
      broadA: createTarget(),
      broadB: createTarget(),
      blurUniforms: {
        texture: gl.getUniformLocation(blurProgram, "uTexture"),
        texel: gl.getUniformLocation(blurProgram, "uTexel"),
        radius: gl.getUniformLocation(blurProgram, "uRadius"),
      },
      materialUniforms: {
        source: gl.getUniformLocation(materialProgram, "uSource"),
        soft: gl.getUniformLocation(materialProgram, "uSoft"),
        broad: gl.getUniformLocation(materialProgram, "uBroad"),
        motion: gl.getUniformLocation(materialProgram, "uMotion"),
        resolution: gl.getUniformLocation(materialProgram, "uResolution"),
        softTexel: gl.getUniformLocation(materialProgram, "uSoftTexel"),
      },
    };
    gl.bindVertexArray(vertexArray);
    gl.disable(gl.BLEND);
  };

  const allocateTarget = (target, width, height) => {
    target.width = Math.max(1, width);
    target.height = Math.max(1, height);
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      target.width,
      target.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      target.texture,
      0,
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("Fluid shader framebuffer is incomplete");
    }
  };

  const allocateTextures = () => {
    if (!resources) return;
    gl.bindTexture(gl.TEXTURE_2D, resources.source);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      pixelWidth,
      pixelHeight,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.bindTexture(gl.TEXTURE_2D, resources.motion);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      pixelWidth,
      pixelHeight,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    allocateTarget(resources.softA, Math.ceil(pixelWidth / 2), Math.ceil(pixelHeight / 2));
    allocateTarget(resources.softB, Math.ceil(pixelWidth / 2), Math.ceil(pixelHeight / 2));
    allocateTarget(resources.broadA, Math.ceil(pixelWidth / 4), Math.ceil(pixelHeight / 4));
    allocateTarget(resources.broadB, Math.ceil(pixelWidth / 4), Math.ceil(pixelHeight / 4));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  const blurInto = (source, target, sourceWidth, sourceHeight, radius) => {
    const { blurProgram, blurUniforms, vertexArray } = resources;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.useProgram(blurProgram);
    gl.bindVertexArray(vertexArray);
    bindTexture(gl, source, 0, blurUniforms.texture);
    gl.uniform2f(blurUniforms.texel, 1 / Math.max(sourceWidth, 1), 1 / Math.max(sourceHeight, 1));
    gl.uniform1f(blurUniforms.radius, radius);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const updateBlurTextures = () => {
    blurInto(resources.source, resources.softA, pixelWidth, pixelHeight, 1.15);
    blurInto(resources.softA.texture, resources.softB, resources.softA.width, resources.softA.height, 1.65);
    blurInto(resources.softB.texture, resources.broadA, resources.softB.width, resources.softB.height, 2.1);
    blurInto(resources.broadA.texture, resources.broadB, resources.broadA.width, resources.broadA.height, 2.65);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  const handleContextLost = (event) => {
    event.preventDefault();
    resources = null;
    notifyAvailability(false);
  };

  const handleContextRestored = () => {
    if (disposed) return;
    try {
      initializeResources();
      allocateTextures();
      notifyAvailability(true);
      if (sourceCanvas) renderer.update(sourceCanvas, motionCanvas);
    } catch (error) {
      console.warn("Unable to restore the fluid surface shader", error);
      notifyAvailability(false);
    }
  };

  canvas.addEventListener("webglcontextlost", handleContextLost);
  canvas.addEventListener("webglcontextrestored", handleContextRestored);

  const renderer = {
    get available() {
      return available && !gl.isContextLost() && Boolean(resources);
    },

    resize(width, height, pixelRatio = 1) {
      const nextWidth = Math.max(1, Math.round(width * pixelRatio));
      const nextHeight = Math.max(1, Math.round(height * pixelRatio));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      if (canvas.width === nextWidth && canvas.height === nextHeight) return false;
      pixelWidth = nextWidth;
      pixelHeight = nextHeight;
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      if (renderer.available) allocateTextures();
      return true;
    },

    update(nextSourceCanvas, nextMotionCanvas = null) {
      if (!renderer.available || !nextSourceCanvas) return false;
      sourceCanvas = nextSourceCanvas;
      motionCanvas = nextMotionCanvas;
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.bindTexture(gl.TEXTURE_2D, resources.source);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        nextSourceCanvas,
      );
      gl.bindTexture(gl.TEXTURE_2D, resources.motion);
      if (nextMotionCanvas) {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA8,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          nextMotionCanvas,
        );
      } else {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA8,
          pixelWidth,
          pixelHeight,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          null,
        );
      }
      updateBlurTextures();
      return true;
    },

    render() {
      if (!renderer.available) return false;
      const { materialProgram, materialUniforms, softB, broadB, vertexArray } = resources;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, pixelWidth, pixelHeight);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(materialProgram);
      gl.bindVertexArray(vertexArray);
      bindTexture(gl, resources.source, 0, materialUniforms.source);
      bindTexture(gl, softB.texture, 1, materialUniforms.soft);
      bindTexture(gl, broadB.texture, 2, materialUniforms.broad);
      bindTexture(gl, resources.motion, 3, materialUniforms.motion);
      gl.uniform2f(materialUniforms.resolution, pixelWidth, pixelHeight);
      gl.uniform2f(materialUniforms.softTexel, 1 / softB.width, 1 / softB.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return true;
    },

    clear() {
      if (!renderer.available) return;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, pixelWidth, pixelHeight);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },

    dispose() {
      disposed = true;
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      canvas.removeEventListener("webglcontextrestored", handleContextRestored);
      deleteResources();
      available = false;
    },
  };

  try {
    initializeResources();
    allocateTextures();
    notifyAvailability(true);
    return renderer;
  } catch (error) {
    console.warn("Unable to initialize the fluid surface shader", error);
    renderer.dispose();
    return null;
  }
}
