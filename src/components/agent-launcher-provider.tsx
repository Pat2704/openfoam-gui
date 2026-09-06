'use client';

/**
 * One compact home for FOAMy, Claude and Codex.
 *
 * The three panels remain independent windows; only their launcher geometry is
 * shared. Closed, the buttons are offset like a small stack of coins. Hovering
 * any one keeps FOAMy at the anchor and fans the two agents up and left, where
 * each can be selected without covering another. Dragging any button moves the
 * whole group, so it never splits back into three unrelated launchers.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { LAUNCHER_Z } from '@/lib/floating-order';

type LauncherName = 'foamy' | 'claude' | 'codex';
type Point = { left: number; top: number };
type Anchor = { right: number; bottom: number };

interface LauncherProps {
  ref: React.RefObject<HTMLButtonElement | null>;
  style: React.CSSProperties;
  onMouseDown: (event: React.MouseEvent) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  isClick: (event: React.MouseEvent) => boolean;
  collapse: () => void;
}

interface LauncherContextValue {
  launcher: (name: LauncherName) => LauncherProps;
}

const LauncherContext = createContext<LauncherContextValue | null>(null);
const BUTTON = 56;
const COLLAPSED: Record<LauncherName, Point> = {
  foamy: { left: 0, top: 0 },
  claude: { left: -8, top: -7 },
  codex: { left: -16, top: -14 },
};
const EXPANDED: Record<LauncherName, Point> = {
  foamy: { left: 0, top: 0 },
  claude: { left: -76, top: -10 },
  codex: { left: -40, top: -72 },
};

export function AgentLauncherProvider({ children }: { children: React.ReactNode }) {
  // Keep one coordinate system from SSR through every client render. Switching
  // from right/bottom to left/top made the transform transition visibly travel
  // from the top-left corner during hydration.
  const [anchor, setAnchor] = useState<Anchor>({ right: 30, bottom: 30 });
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; right: number; bottom: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buttonRefs = useRef<Record<LauncherName, React.RefObject<HTMLButtonElement | null>>>({
    foamy: React.createRef<HTMLButtonElement>(),
    claude: React.createRef<HTMLButtonElement>(),
    codex: React.createRef<HTMLButtonElement>(),
  });

  const place = useCallback(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    if (vw < 100 || vh < 100) return;
    const maxRight = Math.max(0, vw - BUTTON - 88);
    const maxBottom = Math.max(0, vh - BUTTON - 88);
    setAnchor(current => ({
      right: Math.max(0, Math.min(current.right, maxRight)),
      bottom: Math.max(0, Math.min(current.bottom, maxBottom)),
    }));
  }, []);

  useEffect(() => {
    place();
    const onResize = () => place();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [place]);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = event.clientX - d.x, dy = event.clientY - d.y;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) { d.moved = true; dragged.current = true; }
      const maxRight = Math.max(0, window.innerWidth - BUTTON - 88);
      const maxBottom = Math.max(0, window.innerHeight - BUTTON - 88);
      setAnchor({
        right: Math.max(0, Math.min(d.right - dx, maxRight)),
        bottom: Math.max(0, Math.min(d.bottom - dy, maxBottom)),
      });
    };
    const onUp = () => {
      drag.current = null;
      setDragging(false);
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  useEffect(() => () => { if (collapseTimer.current) clearTimeout(collapseTimer.current); }, []);

  const enter = useCallback(() => {
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    setExpanded(true);
  }, []);
  const leave = useCallback(() => {
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    collapseTimer.current = setTimeout(() => setExpanded(false), 140);
  }, []);
  const collapse = useCallback(() => {
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    setExpanded(false);
  }, []);

  const startDrag = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    dragged.current = false;
    setDragging(true);
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      right: anchor.right,
      bottom: anchor.bottom,
      moved: false,
    };
    document.body.style.userSelect = 'none';
  }, [anchor]);

  const launcher = useCallback((name: LauncherName): LauncherProps => {
    const offset = (expanded ? EXPANDED : COLLAPSED)[name];
    return {
      ref: buttonRefs.current[name],
      style: {
        right: anchor.right,
        bottom: anchor.bottom,
        // Windows begin at LAUNCHER_Z + 1 and only increase from there.
        // Keep every part of the anchor below every open or subsequently
        // focused chat window.
        zIndex: expanded
          ? LAUNCHER_Z
          : name === 'foamy' ? LAUNCHER_Z : name === 'claude' ? LAUNCHER_Z - 1 : LAUNCHER_Z - 2,
        transform: `translate(${offset.left}px, ${offset.top}px)`,
        transitionDuration: dragging ? '0ms' : undefined,
        willChange: 'transform',
      },
      onMouseDown: startDrag,
      onMouseEnter: enter,
      onMouseLeave: leave,
      collapse,
      isClick: () => {
        const clicked = !dragged.current;
        dragged.current = false;
        return clicked;
      },
    };
  }, [anchor, collapse, dragging, enter, expanded, leave, startDrag]);

  const value = useMemo(() => ({ launcher }), [launcher]);
  return (
    <LauncherContext.Provider value={value}>
      {children}
      {expanded && (
        <div
          aria-hidden="true"
          className="fixed h-[172px] w-[172px] rounded-full cursor-grab active:cursor-grabbing"
          style={{
            right: anchor.right - 20,
            bottom: anchor.bottom - 30,
            zIndex: LAUNCHER_Z - 3,
          }}
          onMouseDown={startDrag}
          onMouseEnter={enter}
          onMouseLeave={leave}
        />
      )}
    </LauncherContext.Provider>
  );
}

export function useAgentLauncher(name: LauncherName): LauncherProps {
  const context = useContext(LauncherContext);
  if (!context) throw new Error('useAgentLauncher must be used inside AgentLauncherProvider.');
  return context.launcher(name);
}
