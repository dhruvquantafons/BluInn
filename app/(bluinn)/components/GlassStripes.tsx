"use client";

import { useEffect, useRef } from "react";

/**
 * Fluted-glass stripes over a soft, slowly drifting glow, drawn with one
 * WebGL fragment shader (no libraries). Each diagonal stripe acts as a
 * cylindrical lens: it shifts the glow behind it across its width, with the
 * red, green and blue channels shifted by slightly different amounts, which
 * gives the coloured fringes at the stripe edges. The glow leans towards
 * the pointer while it is over the parent element.
 *
 * Fills its parent (absolute, inset 0). If WebGL is unavailable it draws
 * nothing, so whatever background the parent has shows through. The loop
 * stops while the tab is hidden, and a reduced-motion preference gets one
 * still frame.
 */

type Palette = { background: string; shadow: string; midtone: string; highlight: string };

const BLUE: Palette = {
  background: "#06123a",
  shadow: "#173c9f",
  midtone: "#3d74ec",
  highlight: "#d4e4ff",
};

const VERTEX = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAGMENT = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uPointer;
uniform float uPointerMix;
uniform float uStripes;
uniform float uAngle;
uniform vec3 uBg;
uniform vec3 uShadow;
uniform vec3 uMid;
uniform vec3 uHigh;

// The light behind the glass: a main glow that drifts and leans towards the
// pointer, and a fainter second one that wanders on its own.
float glow(vec2 p) {
  float t = uTime;
  vec2 c1 = vec2(0.24 + 0.12 * sin(t * 0.21), 0.10 + 0.11 * cos(t * 0.17));
  c1 = mix(c1, uPointer, uPointerMix);
  vec2 c2 = vec2(-0.22 + 0.10 * cos(t * 0.13), 0.30 + 0.08 * sin(t * 0.29));
  vec2 d1 = p - c1;
  vec2 d2 = p - c2;
  return 0.8 * exp(-dot(d1, d1) * 3.6) + 0.34 * exp(-dot(d2, d2) * 7.0);
}

vec3 ramp(float x) {
  x = clamp(x, 0.0, 1.0);
  vec3 c = mix(uBg, uShadow, smoothstep(0.0, 0.32, x));
  c = mix(c, uMid, smoothstep(0.28, 0.68, x));
  return mix(c, uHigh, smoothstep(0.66, 1.0, x));
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec2 axis = vec2(cos(uAngle), sin(uAngle));
  float width = (uRes.x / uRes.y + 1.0) / uStripes;
  float f = fract(dot(p, axis) / width);

  // Cylindrical lens: the view through a flute is displaced across it. The
  // displacement tapers to nothing over about a pixel at each seam, so the
  // seams are smooth instead of stair-stepped.
  float aa = 1.5 / (width * uRes.y);
  float lens = (f - 0.5) * 2.0;
  lens *= 1.0 - smoothstep(1.0 - 4.0 * aa, 1.0, abs(lens));
  vec2 off = axis * lens * width * 0.9;
  float disp = 0.14;
  float r = glow(p + off * (1.0 + disp));
  float g = glow(p + off);
  float b = glow(p + off * (1.0 - disp));
  vec3 col = vec3(ramp(r).r, ramp(g).g, ramp(b).b);

  // Flute shading: rounder in the middle, a thin sheen, a crisp seam.
  col *= 0.8 + 0.2 * sin(f * 3.14159);
  col += smoothstep(0.07, 0.0, abs(f - 0.2)) * (0.05 + 0.12 * g);
  col += (smoothstep(0.025, 0.0, f) + smoothstep(0.975, 1.0, f)) * 0.05;

  // Keep the left side, where the copy sits, a little deeper...
  col *= mix(0.62, 1.0, smoothstep(-0.55, 0.3, p.x));
  // And the top-left corner, where the logo sits.
  vec2 corner = vec2(-0.5 * uRes.x / uRes.y, 0.5);
  col *= mix(0.7, 1.0, smoothstep(0.08, 0.6, length(p - corner)));

  // Fine grain so the gradients never band.
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) * 0.025;

  gl_FragColor = vec4(col, 1.0);
}
`;

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export default function GlassStripes({
  stripeCount = 14,
  angle = 36,
  colors = BLUE,
  className = "",
}: {
  stripeCount?: number;
  /** Degrees counter-clockwise from vertical. */
  angle?: number;
  colors?: Palette;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const gl = canvas.getContext("webgl", { antialias: false, premultipliedAlpha: false });
    if (!gl) return;

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = compile(gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT);
    if (!vs || !fs) return;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);

    // One triangle that covers the viewport.
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const u = (name: string) => gl.getUniformLocation(prog, name);
    const uRes = u("uRes");
    const uTime = u("uTime");
    const uPointer = u("uPointer");
    const uPointerMix = u("uPointerMix");
    gl.uniform1f(u("uStripes"), Math.min(40, Math.max(6, stripeCount)));
    gl.uniform1f(u("uAngle"), (angle * Math.PI) / 180);
    gl.uniform3fv(u("uBg"), rgb(colors.background));
    gl.uniform3fv(u("uShadow"), rgb(colors.shadow));
    gl.uniform3fv(u("uMid"), rgb(colors.midtone));
    gl.uniform3fv(u("uHigh"), rgb(colors.highlight));

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = Math.max(1, Math.round(host.clientWidth * dpr));
      const h = Math.max(1, Math.round(host.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.uniform2f(uRes, w, h);
    };
    resize();
    const ro = new ResizeObserver(() => {
      resize();
      if (still) draw(0);
    });
    ro.observe(host);

    // Pointer, in the shader's centred coordinates (y up, unit = height).
    const target = { x: 0.24, y: 0.1, mix: 0 };
    const pointer = { x: 0.24, y: 0.1, mix: 0 };
    const onMove = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      target.x = (e.clientX - r.left - r.width / 2) / r.height;
      target.y = -(e.clientY - r.top - r.height / 2) / r.height;
      target.mix = 0.5;
    };
    const onLeave = () => (target.mix = 0);

    let raf = 0;
    const start = performance.now();
    const draw = (t: number) => {
      pointer.x += (target.x - pointer.x) * 0.05;
      pointer.y += (target.y - pointer.y) * 0.05;
      pointer.mix += (target.mix - pointer.mix) * 0.03;
      gl.uniform1f(uTime, t);
      gl.uniform2f(uPointer, pointer.x, pointer.y);
      gl.uniform1f(uPointerMix, pointer.mix);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const loop = () => {
      draw((performance.now() - start) / 1000);
      raf = requestAnimationFrame(loop);
    };
    const onVisibility = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) raf = requestAnimationFrame(loop);
    };

    canvas.dataset.ready = "true";
    if (still) {
      draw(0);
    } else {
      host.addEventListener("pointermove", onMove);
      host.addEventListener("pointerleave", onLeave);
      document.addEventListener("visibilitychange", onVisibility);
      raf = requestAnimationFrame(loop);
    }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", onVisibility);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
    };
  }, [stripeCount, angle, colors]);

  return <canvas ref={canvasRef} aria-hidden="true" className={`admin-glass-stripes ${className}`} />;
}
