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
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
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

// Distinct, colour-blind-friendly-ish hues; patches beyond this wrap around.
const PATCH_COLORS = [
  0x3b82f6, 0xef4444, 0x22c55e, 0xf59e0b, 0xa855f7,
  0x06b6d4, 0xec4899, 0x84cc16, 0xf97316, 0x6366f1,
];

/** Above this, ask before loading — parsing and upload get slow. */
const LARGE_MESH_TRIANGLES = 500_000;

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

/** A number rendered to a texture, drawn as a camera-facing sprite. */
function makeLabelSprite(text: string, colorCss: string, bgCss: string): THREE.Sprite {
  const pad = 8;
  const font = 'bold 48px monospace';
  const measureCtx = document.createElement('canvas').getContext('2d');
  let w = 64;
  if (measureCtx) {
    measureCtx.font = font;
    w = Math.ceil(measureCtx.measureText(text).width) + pad * 2;
  }
  const h = 64;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // A filled pill keeps the number readable against the mesh in both themes.
    ctx.fillStyle = bgCss;
    ctx.globalAlpha = 0.8;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
    ctx.fillStyle = colorCss;
    ctx.fillText(text, w / 2, h / 2 + 2);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, depthTest: false, transparent: true,
  }));
  sprite.renderOrder = 999;
  sprite.userData.aspect = w / h;
  return sprite;
}

/**
 * Resolve one of the app's theme tokens to a concrete rgb() string.
 *
 * The tokens are authored in oklch, which THREE.Color cannot parse, so we let
 * the browser do it: a throwaway element painted with the Tailwind class
 * reports a plain rgb() through getComputedStyle.
 */
function readThemeColors(): { background: string; foreground: string } {
  const fallback = { background: 'rgb(15, 17, 21)', foreground: 'rgb(250, 250, 250)' };
  if (typeof document === 'undefined') return fallback;
  const probe = document.createElement('div');
  probe.className = 'bg-background text-foreground';
  probe.style.cssText = 'position:absolute;opacity:0;pointer-events:none;left:-9999px';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const out = { background: cs.backgroundColor || fallback.background, foreground: cs.color || fallback.foreground };
  document.body.removeChild(probe);
  return out;
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
  const controlsRef = useRef<OrbitControls | null>(null);
  const groupRef = useRef<THREE.Group | null>(null);
  const axesRef = useRef<THREE.AxesHelper | null>(null);
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
  const [showAxes, setShowAxes] = useState(true);
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
      controlsRef.current?.update();
      if (r && s && c) r.render(s, c);
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
    controlsRef.current?.update();
    if (r && s && c) r.render(s, c);
  }, []);

  /** Paint the scene with the app's own background token, light or dark. */
  const applyThemeColors = useCallback(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const { background } = readThemeColors();
    try {
      scene.background = new THREE.Color(background);
    } catch {
      scene.background = new THREE.Color(0x0f1115);
    }
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

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    // Only schedule a frame — never call controls.update() from here, see the
    // comment on requestRender above.
    controls.addEventListener('change', requestRender);

    const group = new THREE.Group();
    scene.add(group);

    const labels = new THREE.Group();
    labels.visible = false;
    scene.add(labels);

    // X red, Y green, Z blue — the OpenFOAM/ParaView convention. Anchored at
    // the origin, which is where the case's coordinate system starts, not at
    // the bounding-box corner. Sized once a mesh is loaded.
    const axes = new THREE.AxesHelper(1);
    axes.visible = false;
    scene.add(axes);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    controlsRef.current = controls;
    groupRef.current = group;
    axesRef.current = axes;
    labelsRef.current = labels;

    themeRef.current?.();

    const resize = () => {
      const w = mount.clientWidth, h = mount.clientHeight;
      if (w === 0 || h === 0) return; // hidden tab: nothing meaningful to size to
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
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
      axes.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      rendererRef.current = null;
    };
  }, [requestRender]);

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

    // Axes long enough to read against the model.
    axesRef.current?.scale.setScalar(radius * 1.4);

    // Sprites are sized in world units, so they must track the model's scale.
    // 0.10 of the radius turned out to be unreadable on a small model; this is
    // sized so the digits stay legible without swamping a coarse block mesh.
    const labelScale = radius * 0.18;
    labelsRef.current?.children.forEach(s => {
      const sp = s as THREE.Sprite;
      const aspect = (sp.userData.aspect as number) || 1;
      sp.scale.set(labelScale * aspect, labelScale, 1);
    });

    cam.near = Math.max(dist / 1000, 1e-6);
    cam.far = dist * 100;
    cam.position.set(center.x + dist * 0.6, center.y + dist * 0.5, center.z + dist * 0.7);
    cam.updateProjectionMatrix();
    ctr.target.copy(center);
    ctr.update();
    renderNow();
  }, [renderNow]);
  // Kept in a ref so loadMesh can frame the model without listing fitToView
  // as a dependency (which would rebuild loadMesh on every camera change).
  useEffect(() => { fitRef.current = fitToView; }, [fitToView]);

  // ── Load the mesh ─────────────────────────────────────────────────────────
  const loadMesh = useCallback(async () => {
    if (!caseName) return;
    setLoading(true);
    setError(null);
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
  }, [caseName]);

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

      // Clear previous labels.
      for (const child of [...labels.children]) {
        const sp = child as THREE.Sprite;
        sp.material.map?.dispose();
        sp.material.dispose();
        labels.remove(child);
      }

      // Read the label colours from the theme too, so numbers stay legible.
      const { foreground, background } = readThemeColors();
      points.forEach((p, i) => {
        const sprite = makeLabelSprite(String(i), foreground, background);
        sprite.position.copy(p);
        labels.add(sprite);
      });

      setLabelCount(points.length);
      labels.visible = true;
      setShowLabels(true);
      fitRef.current?.();   // re-scales the sprites for the current model size
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
  }, [caseName]);

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
    if (axesRef.current) axesRef.current.visible = showAxes && hasMesh;
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
      renderNow();
    }
  }, [active, renderNow]);

  // Switching case invalidates what is on screen.
  useEffect(() => {
    setPatches([]);
    setTriangles(0);
    setHasMesh(false);
    setError(null);
    setLabelCount(0);
    setShowLabels(false);
    if (labelsRef.current) labelsRef.current.visible = false;
  }, [caseName]);

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
                    onClick={() => setShowAxes(a => !a)} title="X red · Y green · Z blue, from the origin">
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
              Drag to rotate · scroll to zoom · right-drag to pan · drag the bar below to resize
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
