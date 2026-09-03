'use client';

/**
 * 3D view of a case's boundary mesh.
 *
 * Shows only the boundary patches, not the volume: it is what you look at to
 * sanity-check a mesh after blockMesh/snappyHexMesh, and it scales with surface
 * area instead of cell count, so a large case stays interactive. For field
 * data, slices and clipping, ParaView remains the right tool.
 *
 * Rendering is ON DEMAND — a frame is drawn when something changes (orbit,
 * toggle, resize), never on a free-running rAF loop. An idle viewer costs no
 * CPU, which matters because this sits in a tab the user may leave open.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { useTheme } from 'next-themes';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import {
  Box, Loader2, RefreshCw, Eye, EyeOff, Grid3x3, Maximize2, AlertTriangle,
  Move3d, Hash,
} from 'lucide-react';
import { confirmDialog } from '@/components/ui/confirm-host';
import CheckMeshPanel from '@/components/openfoam/check-mesh-panel';
import BCValidationPanel from '@/components/openfoam/bc-validation-panel';

// Distinct, colour-blind-friendly-ish hues; patches beyond this wrap around.
const PATCH_COLORS = [
  0x3b82f6, 0xef4444, 0x22c55e, 0xf59e0b, 0xa855f7,
  0x06b6d4, 0xec4899, 0x84cc16, 0xf97316, 0x6366f1,
];

/** Above this, ask before loading — parsing and upload get slow. */
const LARGE_MESH_TRIANGLES = 500_000;

/**
 * Standard viewpoints, as directions the camera sits along looking back at the
 * model. Named the way CFD tools name them: "+X" is the view you get standing
 * on the +X axis, so you are looking down -X.
 */
const STANDARD_VIEWS: { label: string; dir: [number, number, number]; up: [number, number, number] }[] = [
  { label: '+X', dir: [1, 0, 0], up: [0, 0, 1] },
  { label: '-X', dir: [-1, 0, 0], up: [0, 0, 1] },
  { label: '+Y', dir: [0, 1, 0], up: [0, 0, 1] },
  { label: '-Y', dir: [0, -1, 0], up: [0, 0, 1] },
  { label: '+Z', dir: [0, 0, 1], up: [0, 1, 0] },
  { label: '-Z', dir: [0, 0, -1], up: [0, 1, 0] },
  { label: 'Iso', dir: [1, 0.8, 1], up: [0, 1, 0] },
];

const MIN_VIEWER_HEIGHT = 260;
const DEFAULT_VIEWER_HEIGHT = 520;

interface PatchInfo {
  name: string;
  start: number;
  count: number;
  color: number;
  visible: boolean;
}

interface MeshHeader {
  patches: { name: string; start: number; count: number }[];
  triangles: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

/**
 * Pull the vertex list out of a blockMeshDict.
 *
 * Handles the ordinary form — a `vertices ( (x y z) ... );` block plus the
 * `convertToMeters` / `scale` factor. Dictionaries that build their vertices
 * with #calc, macros or variables are not evaluated here: we return what we
 * can parse and the caller reports how many were found, so a partial or empty
 * result is visible rather than silently wrong.
 */
function parseBlockMeshVertices(text: string): { points: THREE.Vector3[]; scale: number } {
  // Strip comments first so they cannot contribute stray parentheses.
  const clean = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  const scaleMatch = clean.match(/\b(?:convertToMeters|scale)\s+([\d.eE+-]+)\s*;/);
  const parsedScale = scaleMatch ? parseFloat(scaleMatch[1]) : 1;
  const scale = Number.isFinite(parsedScale) && parsedScale !== 0 ? parsedScale : 1;

  const block = clean.match(/\bvertices\s*\(([\s\S]*?)\)\s*;/);
  if (!block) return { points: [], scale };

  const points: THREE.Vector3[] = [];
  for (const m of block[1].matchAll(/\(\s*([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s*\)/g)) {
    const x = parseFloat(m[1]), y = parseFloat(m[2]), z = parseFloat(m[3]);
    if ([x, y, z].every(Number.isFinite)) {
      points.push(new THREE.Vector3(x * scale, y * scale, z * scale));
    }
  }
  return { points, scale };
}

/**
 * On-screen height of a vertex label, in CSS pixels.
 *
 * Labels are drawn with size attenuation OFF, so this is what they measure at
 * every zoom level and on every model — see updateLabelScale.
 */
const LABEL_PIXEL_HEIGHT = 16;

/** Texture supersampling, so a label stays crisp on a HiDPI screen. */
const LABEL_TEXTURE_SCALE = 4;

/** A number rendered to a texture, drawn as a camera-facing sprite. */
function makeLabelSprite(text: string, colorCss: string, bgCss: string): THREE.Sprite {
  const s = LABEL_TEXTURE_SCALE;
  const h = LABEL_PIXEL_HEIGHT * s;
  const font = `600 ${Math.round(LABEL_PIXEL_HEIGHT * 0.68) * s}px ui-monospace, monospace`;
  const padX = 4 * s;

  const measureCtx = document.createElement('canvas').getContext('2d');
  let textW = h * 0.6;
  if (measureCtx) {
    measureCtx.font = font;
    textW = measureCtx.measureText(text).width;
  }
  const w = Math.ceil(Math.max(textW + padX * 2, h));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    // A filled pill keeps the number readable against the mesh in both themes;
    // the rounded shape and thin outline stop a row of labels merging into one
    // block when several vertices land close together on screen.
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, h / 2);
    ctx.fillStyle = bgCss;
    ctx.globalAlpha = 0.82;
    ctx.fill();
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = Math.max(1, s * 0.6);
    ctx.strokeStyle = colorCss;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colorCss;
    ctx.fillText(text, w / 2, h / 2 + s * 0.5);
  }

  const tex = new THREE.CanvasTexture(canvas);
  // The texture is drawn several times larger than it is displayed, so it is
  // always minified: mipmaps are what keep the digits from crawling.
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, depthTest: false, transparent: true,
    // Sized in screen space rather than world units: a label keeps the same
    // pixel size however close the camera gets, and however large the case is.
    sizeAttenuation: false,
  }));
  sprite.renderOrder = 999;
  sprite.userData.aspect = w / h;
  return sprite;
}

// ── The orientation triad in the corner ─────────────────────────

/** Side of the square the triad is drawn in, and its inset, both in CSS px. */
const GIZMO_SIZE = 96;
const GIZMO_MARGIN = 10;

/** X red, Y green, Z blue — the OpenFOAM/ParaView convention. */
const AXIS_COLORS: [number, number, number] = [0xef4444, 0x22c55e, 0x3b82f6];
const AXIS_NAMES = ['X', 'Y', 'Z'];

/** A single letter, drawn in its axis colour, for the tip of an arrow. */
function makeAxisLabelSprite(text: string, color: number): THREE.Sprite {
  const s = LABEL_TEXTURE_SCALE;
  const size = 22 * s;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.font = `700 ${Math.round(15 * s)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    ctx.fillText(text, size / 2, size / 2 + s);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, depthTest: false, transparent: true,
  }));
  // The gizmo camera is ORTHOGRAPHIC, so a sprite's scale is plain world units
  // and this is a fixed size on screen — no attenuation to invert.
  sprite.scale.setScalar(0.46);
  sprite.renderOrder = 2;
  return sprite;
}

interface AxisGizmo {
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  root: THREE.Group;
  /** The disc behind the arrows; recoloured when the theme changes. */
  disc: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  dispose: () => void;
}

/**
 * Build the triad: three solid arrows and their letters, in their own scene.
 *
 * Solid geometry rather than an AxesHelper because a line is one pixel wide
 * whatever the material says — at 96 px the helper reads as three faint
 * scratches. MeshBasicMaterial because this scene has no lights and wants
 * none: the triad is a symbol, not part of the model.
 */
function createAxisGizmo(): AxisGizmo {
  const scene = new THREE.Scene();
  // Frustum fixed at ±1.75 with the arrows 1 long: the triad keeps the same
  // size on screen at any zoom, which is the whole point of a corner gizmo.
  const camera = new THREE.OrthographicCamera(-1.75, 1.75, 1.75, -1.75, 0.1, 20);

  const root = new THREE.Group();
  scene.add(root);

  // A translucent disc, so the arrows and letters stay readable over a patch
  // that happens to be the same colour. Kept facing the camera in drawFrame.
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(1.62, 48),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6, depthWrite: false }),
  );
  disc.renderOrder = 0;
  root.add(disc);

  const SHAFT = 0.72, HEAD = 0.3;
  AXIS_COLORS.forEach((color, i) => {
    const material = new THREE.MeshBasicMaterial({ color });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, SHAFT, 12), material);
    shaft.position.y = SHAFT / 2;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.13, HEAD, 14), material);
    head.position.y = SHAFT + HEAD / 2;
    const label = makeAxisLabelSprite(AXIS_NAMES[i], color);
    label.position.y = SHAFT + HEAD + 0.3;

    // Everything is modelled along +Y, then the whole arrow is turned onto its
    // own axis — one rotation per axis instead of three sets of geometry.
    const arm = new THREE.Group();
    arm.add(shaft, head, label);
    if (i === 0) arm.rotation.z = -Math.PI / 2;   // +Y → +X
    if (i === 2) arm.rotation.x = Math.PI / 2;    // +Y → +Z
    root.add(arm);
  });

  return {
    scene, camera, root, disc,
    dispose: () => {
      root.traverse(o => {
        const m = o as THREE.Mesh & { material?: THREE.Material | THREE.Material[] };
        m.geometry?.dispose();
        const mat = m.material as (THREE.Material & { map?: THREE.Texture }) | undefined;
        mat?.map?.dispose();
        mat?.dispose();
      });
    },
  };
}

// Scratch vectors: drawFrame runs on every frame of a drag, so it allocates
// nothing.
const _dir = new THREE.Vector3();
const _size = new THREE.Vector2();
const _origin = new THREE.Vector3();

/**
 * Draw one frame: the model, then the triad over its bottom-left corner.
 *
 * Every render in this component goes through here — the on-demand path, the
 * immediate path and the rAF loop that runs during a gesture — because a
 * viewport left set on the renderer would clip the NEXT frame drawn by anyone
 * who forgot about it.
 */
function drawFrame(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  gizmo: AxisGizmo | null,
  target: THREE.Vector3 | null,
): void {
  renderer.render(scene, camera);
  if (!gizmo || !gizmo.root.visible) return;

  // The triad shows which way the model is turned, so it takes the camera's
  // DIRECTION from the point it is orbiting, and its roll: TrackballControls
  // rolls the camera, and a triad that ignored that would lie about it.
  _dir.subVectors(camera.position, target ?? _origin);
  if (_dir.lengthSq() === 0) return;
  gizmo.camera.position.copy(_dir.normalize()).multiplyScalar(5);
  gizmo.camera.up.copy(camera.up);
  gizmo.camera.lookAt(_origin);
  gizmo.disc.quaternion.copy(gizmo.camera.quaternion);

  renderer.getSize(_size);
  const side = Math.min(GIZMO_SIZE, _size.x * 0.35, _size.y * 0.35);
  if (side < 24) return; // too small a viewer to be worth the corner

  // Scissor as well as viewport: without it clearDepth wipes the depth of the
  // whole frame instead of only the corner's.
  renderer.autoClear = false;
  renderer.setScissorTest(true);
  renderer.setViewport(GIZMO_MARGIN, GIZMO_MARGIN, side, side);
  renderer.setScissor(GIZMO_MARGIN, GIZMO_MARGIN, side, side);
  renderer.clearDepth();
  renderer.render(gizmo.scene, gizmo.camera);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, _size.x, _size.y);
  renderer.autoClear = true;
}

/**
 * Rasterise any CSS colour the browser understands down to plain 0-255 RGB.
 *
 * getComputedStyle does NOT normalise to rgb(): the theme tokens are authored
 * in oklch, and Chromium reports them back as `lab(2.75381 0 0)`. THREE.Color
 * cannot parse that — and, worse, it does not throw: setStyle() warns and
 * leaves the colour untouched, so the scene simply kept whatever background it
 * already had and dark mode appeared to do nothing. Painting the colour onto a
 * 1x1 canvas makes the browser do the conversion for us, and works for any
 * colour space it supports.
 */
function cssColorToRgb(css: string, fallback: [number, number, number]): [number, number, number] {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return fallback;
    // Paint a known colour first: an unparseable fillStyle is ignored silently,
    // so without this we could read a stale pixel and never notice.
    ctx.fillStyle = 'rgb(1, 2, 3)';
    ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    if (d[0] === 1 && d[1] === 2 && d[2] === 3) return fallback; // fillStyle rejected
    return [d[0], d[1], d[2]];
  } catch {
    return fallback;
  }
}

/** Read the app's own background/foreground tokens, resolved to RGB. */
function readThemeColors(): { background: [number, number, number]; foregroundCss: string; backgroundCss: string } {
  const fallback: [number, number, number] = [15, 17, 21];
  if (typeof document === 'undefined') {
    return { background: fallback, foregroundCss: 'white', backgroundCss: 'black' };
  }
  const probe = document.createElement('div');
  probe.className = 'bg-background text-foreground';
  probe.style.cssText = 'position:absolute;opacity:0;pointer-events:none;left:-9999px';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const bgCss = cs.backgroundColor;
  const fgCss = cs.color;
  document.body.removeChild(probe);
  // Label sprites go through canvas fillStyle, which handles lab()/oklch()
  // natively, so those keep the CSS string.
  return { background: cssColorToRgb(bgCss, fallback), foregroundCss: fgCss, backgroundCss: bgCss };
}

export default function MeshViewer({ caseName, active = true }: {
  caseName: string;
  /** False while another tab is on screen — we skip resize work and redraws. */
  active?: boolean;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<TrackballControls | null>(null);
  const groupRef = useRef<THREE.Group | null>(null);
  const gizmoRef = useRef<AxisGizmo | null>(null);
  const labelsRef = useRef<THREE.Group | null>(null);
  const frameRef = useRef<number | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const themeRef = useRef<(() => void) | null>(null);

  const { resolvedTheme } = useTheme();

  const [loading, setLoading] = useState(false);
  const [labelsLoading, setLabelsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [patches, setPatches] = useState<PatchInfo[]>([]);
  const [triangles, setTriangles] = useState(0);
  const [wireframe, setWireframe] = useState(false);
  // Nothing is switched on when a mesh loads — not even the axes. The view
  // starts as bare geometry and the user turns on what they want.
  const [showAxes, setShowAxes] = useState(false);
  const [showLabels, setShowLabels] = useState(false);
  const [labelCount, setLabelCount] = useState(0);
  const [hasMesh, setHasMesh] = useState(false);
  const [height, setHeight] = useState(DEFAULT_VIEWER_HEIGHT);

  // ── Draw one frame, coalescing multiple requests in the same tick ─────────
  //
  // controls.update() lives HERE and not in the 'change' listener. OrbitControls
  // dispatches 'change' from inside update(), so calling update() from that
  // listener recurses until the stack blows ("Maximum call stack size
  // exceeded"). Scheduling a frame is safe: requestRender only ever queues.
  const requestRender = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const r = rendererRef.current, s = sceneRef.current, c = cameraRef.current;
      const ctr = controlsRef.current;
      ctr?.update();
      if (r && s && c) drawFrame(r, s, c, gizmoRef.current, ctr?.target ?? null);
    });
  }, []);

  /**
   * Draw straight away instead of waiting for the next animation frame.
   *
   * Used for one-off changes the user just triggered — fitting the view,
   * toggling a patch, switching back to the tab. Besides feeling more
   * immediate, it means the first frame after loading a mesh does not depend
   * on rAF running: a window that is occluded or throttled would otherwise
   * leave the canvas black until the user interacted with it.
   */
  const renderNow = useCallback(() => {
    const r = rendererRef.current, s = sceneRef.current, c = cameraRef.current;
    const ctr = controlsRef.current;
    ctr?.update();
    if (r && s && c) drawFrame(r, s, c, gizmoRef.current, ctr?.target ?? null);
  }, []);

  /**
   * Size the vertex labels in SCREEN space.
   *
   * The sprites have size attenuation off, which makes three read their scale
   * as a fraction of the viewport: a sprite of scale.y = k covers 0.5 * f * k
   * of the viewport height, where f = projectionMatrix[5] = 1 / tan(fov / 2).
   * Inverting that pins every label to LABEL_PIXEL_HEIGHT on screen.
   *
   * The old sizing was in world units and computed once per fit, so the labels
   * grew with the mesh as you zoomed in — a couple of scroll clicks and the
   * numbers covered the model.
   */
  const updateLabelScale = useCallback(() => {
    const cam = cameraRef.current, mount = mountRef.current, labels = labelsRef.current;
    if (!cam || !mount || !labels) return;
    const viewportH = mount.clientHeight;
    const f = cam.projectionMatrix.elements[5];
    if (viewportH === 0 || !f) return;
    const scaleY = (2 * LABEL_PIXEL_HEIGHT) / (viewportH * f);
    for (const child of labels.children) {
      const sp = child as THREE.Sprite;
      const aspect = (sp.userData.aspect as number) || 1;
      sp.scale.set(scaleY * aspect, scaleY, 1);
    }
  }, []);

  /** Paint the scene with the app's own background token, light or dark. */
  const applyThemeColors = useCallback(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const [r, g, b] = readThemeColors().background;
    scene.background = new THREE.Color(r / 255, g / 255, b / 255);
    // The triad's backing disc takes the same colour, so it stays a soft plate
    // under the arrows in either theme rather than a grey blob.
    gizmoRef.current?.disc.material.color.setRGB(r / 255, g / 255, b / 255);
    renderNow();
  }, [renderNow]);
  useEffect(() => { themeRef.current = applyThemeColors; }, [applyThemeColors]);

  // ── One-time three.js setup ───────────────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 10000);
    camera.position.set(3, 2, 4);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    // Two lights plus a little ambient: enough to read curvature on a coloured
    // surface without any of the faces going fully black.
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 0.85);
    key.position.set(1, 1.4, 1);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-1, -0.6, -1);
    scene.add(fill);

    // TrackballControls, not OrbitControls: Orbit keeps the camera's up vector
    // pinned and clamps the polar angle to [0, pi], so dragging upwards stops
    // dead once you reach the top of the model and the view can never be
    // rolled. Trackball carries the up vector round with the camera, giving the
    // unconstrained rotation ParaView's default camera has.
    const controls = new TrackballControls(camera, renderer.domElement);
    // Trackball measures a drag against the canvas radius while Orbit mapped a
    // full-width drag to a full turn; 3.0 lands on roughly the old feel. Pan is
    // 2 * tan(fov / 2), which keeps a right-drag tracking the pointer 1:1.
    controls.rotateSpeed = 3.0;
    controls.zoomSpeed = 1.2;
    controls.panSpeed = 0.8;
    controls.staticMoving = false;
    controls.dynamicDampingFactor = 0.15;
    // Trackball's A/S/D shortcuts are bound on WINDOW, not on the canvas, so
    // they would fire while the user types in the editor. Disabled.
    controls.keys = ['', '', ''];
    // Only schedule a frame — never call controls.update() from here, see the
    // comment on requestRender above.
    controls.addEventListener('change', requestRender);

    // Trackball caches the canvas rectangle instead of reading it per gesture,
    // so it has to be refreshed whenever the canvas moves. Capture phase on the
    // parent runs before the controls' own pointerdown handler on the canvas,
    // which is where the first sample of a drag is taken.
    const syncControlsRect = () => controls.handleResize();
    mount.addEventListener('pointerdown', syncControlsRect, true);

    // Rendering stays on demand, with one exception: while a gesture is in
    // flight we drive a real rAF loop.
    //
    // TrackballControls only emits 'change' once the camera has moved further
    // than its own epsilon — distanceToSquared > 1e-6, i.e. 1e-3 world units.
    // An OpenFOAM case is often centimetres across, so a slow drag moves the
    // camera less than that per frame and the view would appear to freeze
    // mid-gesture. The loop stops shortly after the gesture ends, so an idle
    // viewer still costs nothing.
    let interacting = false;
    let tailUntil = 0;
    let spinId: number | null = null;
    const spin = () => {
      if (!interacting && performance.now() > tailUntil) { spinId = null; return; }
      spinId = requestAnimationFrame(spin);
      controls.update();
      drawFrame(renderer, scene, camera, gizmo, controls.target);
    };
    const kickSpin = () => { if (spinId === null) spinId = requestAnimationFrame(spin); };
    const onControlStart = () => { interacting = true; kickSpin(); };
    // A wheel event fires start and end back to back, so the tail is also what
    // carries the damping out after a zoom.
    const onControlEnd = () => { interacting = false; tailUntil = performance.now() + 600; kickSpin(); };
    controls.addEventListener('start', onControlStart);
    controls.addEventListener('end', onControlEnd);

    const group = new THREE.Group();
    scene.add(group);

    const labels = new THREE.Group();
    labels.visible = false;
    scene.add(labels);

    // The orientation triad. It lives in its OWN scene and is drawn into the
    // bottom-left corner after the model — not anchored in the case's own
    // coordinates, where it had to be rescaled to every model and still ended
    // up either lost inside the geometry or larger than it.
    const gizmo = createAxisGizmo();
    gizmo.root.visible = false;

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    controlsRef.current = controls;
    groupRef.current = group;
    gizmoRef.current = gizmo;
    labelsRef.current = labels;

    themeRef.current?.();

    const resize = () => {
      const w = mount.clientWidth, h = mount.clientHeight;
      if (w === 0 || h === 0) return; // hidden tab: nothing meaningful to size to
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      controls.handleResize();
      updateLabelScale();
      requestRender();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    // next-themes flips a class on <html>, and it does so from its own effect —
    // there is no ordering guarantee against ours, so reading the token when
    // `resolvedTheme` changes can sample the OLD colour. Watching the attribute
    // instead fires once the class has actually landed, whatever the order.
    const themeObserver = new MutationObserver(() => themeRef.current?.());
    themeObserver.observe(document.documentElement, {
      attributes: true, attributeFilter: ['class', 'style', 'data-theme'],
    });

    return () => {
      themeObserver.disconnect();
      ro.disconnect();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (spinId !== null) cancelAnimationFrame(spinId);
      mount.removeEventListener('pointerdown', syncControlsRect, true);
      controls.dispose();
      for (const root of [group, labels]) {
        root.traverse(o => {
          const m = o as THREE.Mesh & { material?: THREE.Material | THREE.Material[] };
          m.geometry?.dispose();
          const mat = m.material;
          if (Array.isArray(mat)) mat.forEach(x => x.dispose());
          else mat?.dispose();
        });
      }
      gizmo.dispose();
      gizmoRef.current = null;
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      rendererRef.current = null;
    };
  }, [requestRender, updateLabelScale]);

  // Belt and braces alongside the MutationObserver above: deferred by a frame
  // so the class is on <html> by the time we sample the token.
  useEffect(() => {
    const id = requestAnimationFrame(() => applyThemeColors());
    return () => cancelAnimationFrame(id);
  }, [resolvedTheme, applyThemeColors]);

  // ── Frame the model ───────────────────────────────────────────────────────
  const fitToView = useCallback(() => {
    const group = groupRef.current, cam = cameraRef.current, ctr = controlsRef.current;
    if (!group || !cam || !ctr || group.children.length === 0) return;

    const box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
    const dist = radius / Math.sin((cam.fov * Math.PI) / 360) * 1.6;

    cam.near = Math.max(dist / 1000, 1e-6);
    cam.far = dist * 100;
    cam.position.set(center.x + dist * 0.6, center.y + dist * 0.5, center.z + dist * 0.7);
    cam.updateProjectionMatrix();
    ctr.target.copy(center);
    ctr.update();
    updateLabelScale();
    renderNow();
  }, [renderNow, updateLabelScale]);
  // Kept in a ref so loadMesh can frame the model without listing fitToView
  // as a dependency (which would rebuild loadMesh on every camera change).
  useEffect(() => { fitRef.current = fitToView; }, [fitToView]);

  /**
   * Jump to one of the standard viewpoints, keeping the model framed.
   *
   * Distance is recomputed from the bounding sphere rather than preserved, so
   * the model fills the view the same way from every direction — otherwise
   * switching from an axis view to Iso leaves it tiny or clipped.
   */
  const setView = useCallback((dir: [number, number, number], up: [number, number, number]) => {
    const group = groupRef.current, cam = cameraRef.current, ctr = controlsRef.current;
    if (!group || !cam || !ctr || group.children.length === 0) return;

    const box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
    const dist = radius / Math.sin((cam.fov * Math.PI) / 360) * 1.6;

    const v = new THREE.Vector3(...dir).normalize().multiplyScalar(dist);
    cam.up.set(...up);
    cam.near = Math.max(dist / 1000, 1e-6);
    cam.far = dist * 100;
    cam.position.copy(center).add(v);
    cam.updateProjectionMatrix();
    ctr.target.copy(center);
    ctr.update();
    renderNow();
  }, [renderNow]);

  // ── Load the mesh ─────────────────────────────────────────────────────────
  /**
   * Drop the vertex sprites and their textures.
   *
   * The labels describe system/blockMeshDict, not the mesh, so they go stale
   * the moment either changes — and a sprite that is merely hidden is still
   * there to be shown again, which is exactly how a stale number survived.
   */
  const clearVertexLabels = useCallback(() => {
    const labels = labelsRef.current;
    if (!labels) return;
    for (const child of [...labels.children]) {
      const sp = child as THREE.Sprite;
      sp.material.map?.dispose();
      sp.material.dispose();
      labels.remove(child);
    }
    labels.visible = false;
  }, []);

  const loadMesh = useCallback(async () => {
    if (!caseName) return;
    setLoading(true);
    setError(null);

    // A reload starts from the state a first load starts from: every toggle
    // off, and nothing carried over from the mesh being replaced.
    //
    // The vertex labels are why this exists. They are read from
    // system/blockMeshDict once and then kept in the scene, and toggleLabels
    // reuses whatever is already there instead of re-reading the file — so
    // after editing the dictionary and re-meshing, the numbers on screen still
    // described the OLD vertices and no amount of pressing Reload changed
    // them. Clearing them here makes the next press of Vertices read the file
    // again. Wireframe and the axes are reset with them so the whole toolbar
    // means what it shows after a reload, which is what the user asked for.
    clearVertexLabels();
    setLabelCount(0);
    setShowLabels(false);
    setWireframe(false);
    setShowAxes(false);

    try {
      const res = await fetch(`/api/mesh?case=${encodeURIComponent(caseName)}`);
      if (!res.ok) {
        const msg = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(msg.error || `HTTP ${res.status}`);
      }

      const buf = await res.arrayBuffer();
      const view = new DataView(buf);
      const headerLen = view.getUint32(0, true);
      const header: MeshHeader = JSON.parse(
        new TextDecoder().decode(new Uint8Array(buf, 4, headerLen))
      );
      const positions = new Float32Array(buf, 4 + headerLen);

      if (header.triangles > LARGE_MESH_TRIANGLES) {
        const ok = await confirmDialog(
          `This surface has ${header.triangles.toLocaleString()} triangles. ` +
          `Displaying it may make the view sluggish. Load it anyway?`,
          { title: 'Large mesh', confirmLabel: 'Load', destructive: false }
        );
        if (!ok) { setLoading(false); return; }
      }

      const group = groupRef.current;
      if (!group) return;

      // Drop whatever was displayed before.
      for (const child of [...group.children]) {
        const m = child as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material;
        if (Array.isArray(mat)) mat.forEach(x => x.dispose());
        else mat?.dispose();
        group.remove(child);
      }

      // One mesh per patch: lets each be hidden and coloured independently.
      const built: PatchInfo[] = header.patches.map((p, i) => {
        const color = PATCH_COLORS[i % PATCH_COLORS.length];
        const geom = new THREE.BufferGeometry();
        geom.setAttribute(
          'position',
          new THREE.BufferAttribute(positions.subarray(p.start * 3, (p.start + p.count) * 3), 3)
        );
        // STL normals were dropped server-side; non-indexed positions give the
        // same flat normals back for free.
        geom.computeVertexNormals();

        const mat = new THREE.MeshLambertMaterial({
          color, side: THREE.DoubleSide, wireframe: false,
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.name = p.name;
        group.add(mesh);

        return { name: p.name, start: p.start, count: p.count, color, visible: true };
      });

      setPatches(built);
      setTriangles(header.triangles);
      setHasMesh(true);
      fitRef.current?.();
      toast.success(`${header.triangles.toLocaleString()} triangles, ${built.length} patches`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load the mesh';
      // Keep the stack: the failures here (buffer alignment, three.js limits)
      // are not diagnosable from the message alone.
      console.error('[mesh-viewer] load failed', e);
      setError(msg);
      setHasMesh(false);
    } finally {
      setLoading(false);
    }
  }, [caseName, clearVertexLabels]);

  // ── blockMeshDict vertex numbering ────────────────────────────────────────
  const loadVertexLabels = useCallback(async () => {
    const labels = labelsRef.current;
    if (!labels || !caseName) return;
    setLabelsLoading(true);
    try {
      const res = await fetch(
        `/api/cases/${encodeURIComponent(caseName)}?action=read&path=${encodeURIComponent('system/blockMeshDict')}`
      );
      const data = await res.json();
      if (!res.ok || !data.content) {
        throw new Error(data.error || 'system/blockMeshDict not found');
      }

      const { points, scale } = parseBlockMeshVertices(data.content);
      if (points.length === 0) {
        throw new Error(
          'No numeric vertices found in blockMeshDict — it may build them with #calc or macros.'
        );
      }

      clearVertexLabels();

      // Read the label colours from the theme too, so numbers stay legible.
      const { foregroundCss, backgroundCss } = readThemeColors();
      points.forEach((p, i) => {
        const sprite = makeLabelSprite(String(i), foregroundCss, backgroundCss);
        sprite.position.copy(p);
        labels.add(sprite);
      });

      setLabelCount(points.length);
      labels.visible = true;
      setShowLabels(true);
      // Size the new sprites for the current viewport. Deliberately NOT a
      // re-fit: the labels are screen-sized now, and refitting would throw away
      // whatever view the user had set up before asking for the numbering.
      updateLabelScale();
      renderNow();
      toast.success(
        `${points.length} blockMeshDict vertices` + (scale !== 1 ? ` (scale ${scale})` : '')
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to read blockMeshDict';
      toast.error(msg);
      setError(msg);
    } finally {
      setLabelsLoading(false);
    }
  }, [caseName, updateLabelScale, renderNow, clearVertexLabels]);

  const toggleLabels = useCallback(() => {
    const labels = labelsRef.current;
    if (!labels) return;
    // Ask the scene, not React state: the two can disagree (the scene is
    // rebuilt when the component remounts while the count survives), and an
    // empty group would otherwise be toggled on to no visible effect.
    if (labels.children.length === 0) { void loadVertexLabels(); return; }
    labels.visible = !labels.visible;
    setShowLabels(labels.visible);
    renderNow();
  }, [loadVertexLabels, renderNow]);

  // ── Patch visibility / wireframe / axes ───────────────────────────────────
  const togglePatch = useCallback((name: string) => {
    const group = groupRef.current;
    if (!group) return;
    setPatches(prev => prev.map(p => {
      if (p.name !== name) return p;
      const obj = group.getObjectByName(name);
      if (obj) obj.visible = !p.visible;
      return { ...p, visible: !p.visible };
    }));
    renderNow();
  }, [renderNow]);

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    group.traverse(o => {
      const mat = (o as THREE.Mesh).material as THREE.MeshLambertMaterial | undefined;
      if (mat && 'wireframe' in mat) mat.wireframe = wireframe;
    });
    renderNow();
  }, [wireframe, renderNow]);

  useEffect(() => {
    if (gizmoRef.current) gizmoRef.current.root.visible = showAxes && hasMesh;
    renderNow();
  }, [showAxes, hasMesh, renderNow]);

  // ── Resizable viewport ────────────────────────────────────────────────────
  // A drag strip along the bottom edge. The existing ResizeObserver picks the
  // new size up, so the renderer and camera follow without extra wiring.
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const onDragStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startH: height };
  }, [height]);
  const onDragMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setHeight(Math.max(MIN_VIEWER_HEIGHT, d.startH + (e.clientY - d.startY)));
  }, []);
  const onDragEnd = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }, []);

  // Coming back to the tab: the canvas was sized against a hidden (0x0) parent,
  // so re-measure and redraw.
  useEffect(() => {
    if (!active) return;
    const mount = mountRef.current, r = rendererRef.current, c = cameraRef.current;
    if (!mount || !r || !c) return;
    const w = mount.clientWidth, h = mount.clientHeight;
    if (w > 0 && h > 0) {
      r.setSize(w, h, false);
      c.aspect = w / h;
      c.updateProjectionMatrix();
      controlsRef.current?.handleResize();
      updateLabelScale();
      renderNow();
    }
  }, [active, renderNow, updateLabelScale]);

  // Switching case invalidates what is on screen, exactly as a reload does.
  useEffect(() => {
    setPatches([]);
    setTriangles(0);
    setHasMesh(false);
    setError(null);
    setLabelCount(0);
    setShowLabels(false);
    setWireframe(false);
    setShowAxes(false);
    clearVertexLabels();
  }, [caseName, clearVertexLabels]);

  if (!caseName) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
        <div className="text-center">
          <Box className="w-12 h-12 mx-auto mb-2 opacity-30" />
          <p>Select a case from the Dashboard to view its mesh</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="py-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-sm flex items-center gap-2">
              <Box className="w-4 h-4" /> Boundary Mesh
              {triangles > 0 && (
                <>
                  <Badge variant="secondary" className="text-[10px] font-mono">
                    {triangles.toLocaleString()} tri
                  </Badge>
                  <Badge variant="secondary" className="text-[10px] font-mono">
                    {patches.length} patches
                  </Badge>
                </>
              )}
            </CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              <Button size="sm" variant="outline" className="h-7 text-xs"
                onClick={loadMesh} disabled={loading}>
                {loading
                  ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Extracting…</>
                  : <><RefreshCw className="w-3 h-3 mr-1" /> {hasMesh ? 'Reload' : 'Load mesh'}</>}
              </Button>
              {hasMesh && (
                <>
                  <Button size="sm" variant={wireframe ? 'default' : 'outline'} className="h-7 text-xs"
                    onClick={() => setWireframe(w => !w)}>
                    <Grid3x3 className="w-3 h-3 mr-1" /> Wireframe
                  </Button>
                  <Button size="sm" variant={showAxes ? 'default' : 'outline'} className="h-7 text-xs"
                    onClick={() => setShowAxes(a => !a)} title="Orientation triad in the corner — X red, Y green, Z blue">
                    <Move3d className="w-3 h-3 mr-1" /> Axes
                  </Button>
                  <Button size="sm" variant={showLabels ? 'default' : 'outline'} className="h-7 text-xs"
                    onClick={toggleLabels} disabled={labelsLoading}
                    title="Vertex numbers from system/blockMeshDict">
                    {labelsLoading
                      ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Reading…</>
                      : <><Hash className="w-3 h-3 mr-1" /> Vertices{labelCount > 0 ? ` (${labelCount})` : ''}</>}
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={fitToView}>
                    <Maximize2 className="w-3 h-3 mr-1" /> Fit
                  </Button>
                  {/* Standard viewpoints — looking down an axis is how you
                      check a 2D case is actually flat. */}
                  <div className="flex items-center rounded-md border overflow-hidden">
                    {STANDARD_VIEWS.map(v => (
                      <button
                        key={v.label}
                        onClick={() => setView(v.dir, v.up)}
                        className="px-1.5 h-7 text-[10px] font-mono hover:bg-accent transition-colors border-r last:border-r-0"
                        title={`View along ${v.label}`}
                      >
                        {v.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </CardHeader>

        <CardContent className="pt-0">
          {error && (
            <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-xs">
              <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {hasMesh && patches.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {patches.map(p => (
                <button
                  key={p.name}
                  onClick={() => togglePatch(p.name)}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-mono transition-opacity ${
                    p.visible ? 'opacity-100' : 'opacity-40'
                  }`}
                  title={`${p.count / 3} triangles — click to ${p.visible ? 'hide' : 'show'}`}
                >
                  <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                    style={{ backgroundColor: `#${p.color.toString(16).padStart(6, '0')}` }} />
                  {p.name}
                  {p.visible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                </button>
              ))}
            </div>
          )}

          <div
            ref={mountRef}
            className="w-full rounded-t-lg overflow-hidden border border-b-0 bg-background"
            style={{ height }}
          >
            {!hasMesh && !loading && (
              <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                <div className="text-center">
                  <Box className="w-10 h-10 mx-auto mb-2 opacity-20" />
                  <p>Press <span className="font-medium">Load mesh</span> to extract and display the boundary patches</p>
                  <p className="text-xs mt-1 opacity-70">Requires a meshed case — run blockMesh first</p>
                </div>
              </div>
            )}
          </div>

          {/* Drag the bottom edge to make the view taller. */}
          <div
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
            onDoubleClick={() => setHeight(DEFAULT_VIEWER_HEIGHT)}
            className="h-2.5 w-full rounded-b-lg border border-t-0 bg-muted hover:bg-accent cursor-ns-resize flex items-center justify-center touch-none select-none"
            title="Drag to resize · double-click to reset"
          >
            <span className="w-8 h-0.5 rounded-full bg-muted-foreground/40" />
          </div>

          {hasMesh && (
            <p className="mt-2 text-[10px] text-muted-foreground">
              Drag to rotate freely · scroll or middle-drag to zoom · right-drag to pan · drag the bar below to resize
            </p>
          )}
        </CardContent>
      </Card>

      {/* Mesh quality and boundary conditions live here rather than in the
          Monitor tab: both describe the mesh, not the running solve. */}
      <CheckMeshPanel caseName={caseName} />
      <BCValidationPanel caseName={caseName} />
    </div>
  );
}
