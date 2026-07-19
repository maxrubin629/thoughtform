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
uniform vec2 uResolution;
uniform vec2 uSoftTexel;
uniform vec2 uBroadTexel;
uniform float uTime;

in vec2 vUv;
out vec4 outColor;

float hash21(vec2 point) {
  point = fract(point * vec2(123.34, 456.21));
  point += dot(point, point + 45.32);
  return fract(point.x * point.y);
}

float valueNoise(vec2 point) {
  vec2 cell = floor(point);
  vec2 local = fract(point);
  local = local * local * (3.0 - 2.0 * local);
  float a = hash21(cell);
  float b = hash21(cell + vec2(1.0, 0.0));
  float c = hash21(cell + vec2(0.0, 1.0));
  float d = hash21(cell + vec2(1.0, 1.0));
  return mix(mix(a, b, local.x), mix(c, d, local.x), local.y);
}

void main() {
  vec4 source = texture(uSource, vUv);
  float coverage = source.a;
  float soft = texture(uSoft, vUv).a;
  float broad = texture(uBroad, vUv).a;

  float softLeft = texture(uSoft, vUv - vec2(uSoftTexel.x * 1.45, 0.0)).a;
  float softRight = texture(uSoft, vUv + vec2(uSoftTexel.x * 1.45, 0.0)).a;
  float softDown = texture(uSoft, vUv - vec2(0.0, uSoftTexel.y * 1.45)).a;
  float softUp = texture(uSoft, vUv + vec2(0.0, uSoftTexel.y * 1.45)).a;
  float broadLeft = texture(uBroad, vUv - vec2(uBroadTexel.x * 1.1, 0.0)).a;
  float broadRight = texture(uBroad, vUv + vec2(uBroadTexel.x * 1.1, 0.0)).a;
  float broadDown = texture(uBroad, vUv - vec2(0.0, uBroadTexel.y * 1.1)).a;
  float broadUp = texture(uBroad, vUv + vec2(0.0, uBroadTexel.y * 1.1)).a;

  float slopeX = (softRight - softLeft) * 0.78 + (broadRight - broadLeft) * 0.42;
  float slopeY = (softUp - softDown) * 0.78 + (broadUp - broadDown) * 0.42;
  vec3 normal = normalize(vec3(-slopeX * 6.6, -slopeY * 6.6, 0.56));
  vec3 light = normalize(vec3(-0.52, 0.64, 0.76));
  vec3 view = vec3(0.0, 0.0, 1.0);
  vec3 halfVector = normalize(light + view);

  float diffuse = 0.94 + max(dot(normal, light), 0.0) * 0.16;
  float specular = pow(max(dot(normal, halfVector), 0.0), 38.0);
  float softSpecular = pow(max(dot(normal, halfVector), 0.0), 8.0);
  float broadEdge = clamp((coverage - broad) * 1.75, 0.0, 1.0);
  float innerEdge = clamp((coverage - soft) * 3.3, 0.0, 1.0);
  float outerEdge = clamp((soft - coverage) * 3.6, 0.0, 1.0);
  float edgeFacingLight = smoothstep(-0.2, 0.84, dot(normal, light));
  float litEdge = innerEdge * edgeFacingLight;
  float pearlShoulder = broadEdge * (1.0 - innerEdge * 0.62) * edgeFacingLight;

  vec2 aspectPoint = vec2(vUv.x * (uResolution.x / max(uResolution.y, 1.0)), vUv.y);
  float slowNoise = valueNoise(aspectPoint * 7.0 + vec2(uTime * 0.018, -uTime * 0.012));
  float fineNoise = valueNoise(aspectPoint * 29.0 - vec2(uTime * 0.025, uTime * 0.018));
  float movingBand = sin((aspectPoint.x * 0.74 + aspectPoint.y) * 11.0 - uTime * 0.11 + slowNoise * 1.4);
  movingBand = pow(max(movingBand, 0.0), 7.0) * 0.035;

  vec3 base = source.rgb;
  base *= diffuse;
  base *= 0.965 + (slowNoise - 0.5) * 0.055 + (fineNoise - 0.5) * 0.018;
  base += vec3(1.0, 0.53, 0.40) * broad * 0.05;
  base += vec3(1.0, 0.93, 0.82) * softSpecular * 0.13;
  base += vec3(1.0, 0.975, 0.91) * specular * 0.78;
  base += vec3(1.0, 0.78, 0.68) * litEdge * 0.4;
  base += vec3(1.0, 0.94, 0.86) * pearlShoulder * 0.43;
  base += vec3(1.0, 0.92, 0.82) * movingBand * coverage;
  base = clamp(base, 0.0, 1.0);

  vec2 shadowOffset = vec2(-6.0 / max(uResolution.x, 1.0), 7.0 / max(uResolution.y, 1.0));
  float shiftedBroad = texture(uBroad, vUv + shadowOffset).a;
  float shadow = max(shiftedBroad - max(coverage, outerEdge * 0.18), 0.0);
  shadow = smoothstep(0.015, 0.52, shadow) * 0.13;
  float rimAlpha = outerEdge * smoothstep(-0.12, 0.95, dot(normal, light)) * 0.62;
  vec3 rimColor = vec3(1.0, 0.91, 0.82);
  vec3 shadowColor = vec3(0.31, 0.20, 0.16);

  float materialAlpha = clamp(coverage + rimAlpha * (1.0 - coverage), 0.0, 1.0);
  float shadowAlpha = shadow * (1.0 - materialAlpha);
  float finalAlpha = materialAlpha + shadowAlpha;
  if (finalAlpha < 0.001) discard;

  vec3 materialColor = mix(rimColor, base, smoothstep(0.0, 0.7, coverage));
  vec3 finalColor = (
    materialColor * materialAlpha
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
    [resources.source, resources.softA.texture, resources.softB.texture,
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
        resolution: gl.getUniformLocation(materialProgram, "uResolution"),
        softTexel: gl.getUniformLocation(materialProgram, "uSoftTexel"),
        broadTexel: gl.getUniformLocation(materialProgram, "uBroadTexel"),
        time: gl.getUniformLocation(materialProgram, "uTime"),
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
      if (sourceCanvas) renderer.update(sourceCanvas);
    } catch (error) {
      console.warn("Unable to restore the pearlescent fluid shader", error);
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

    update(nextSourceCanvas) {
      if (!renderer.available || !nextSourceCanvas) return false;
      sourceCanvas = nextSourceCanvas;
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
      updateBlurTextures();
      return true;
    },

    render(now, { reducedMotion = false } = {}) {
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
      gl.uniform2f(materialUniforms.resolution, pixelWidth, pixelHeight);
      gl.uniform2f(materialUniforms.softTexel, 1 / softB.width, 1 / softB.height);
      gl.uniform2f(materialUniforms.broadTexel, 1 / broadB.width, 1 / broadB.height);
      gl.uniform1f(materialUniforms.time, reducedMotion ? 0 : now / 1000);
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
    console.warn("Unable to initialize the pearlescent fluid shader", error);
    renderer.dispose();
    return null;
  }
}
