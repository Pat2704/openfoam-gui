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

type LauncherName = 'foamy' | 'claude' | 'codex';
type Point = { left: number; top: number };

interface LauncherProps {
  ref: React.RefObject<HTMLButtonElement | null>;
  style: React.CSSProperties;
  onMouseDown: (event: React.MouseEvent) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  isClick: (event: React.MouseEvent) => boolean;
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
  const [anchor, setAnchor] = useState<Point>({ left: 0, top: 0 });
  const [ready, setReady] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buttonRefs = useRef<Record<LauncherName, React.RefObject<HTMLButtonElement | null>>>({
    foamy: React.createRef<HTMLButtonElement>(),
    claude: React.createRef<HTMLButtonElement>(),
    codex: React.createRef<HTMLButtonElement>(),
  });

  const place = useCallback((force = false) => {
    const vw = window.innerWidth, vh = window.innerHeight;
    if (vw < 100 || vh < 100) return;
    setAnchor(current => {
      const outside = current.left > vw - BUTTON || current.top > vh - BUTTON || current.left < 0 || current.top < 0;
      if (!force && ready && !outside) return current;
      return { left: Math.max(88, vw - 86), top: Math.max(88, vh - 86) };
    });
    setReady(true);
  }, [ready]);

  useEffect(() => {
    place();
    const frame = requestAnimationFrame(() => place());
    const onResize = () => place();
    window.addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', onResize); };
  }, [place]);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = event.clientX - d.x, dy = event.clientY - d.y;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) { d.moved = true; dragged.current = true; }
      setAnchor({
        left: Math.max(88, Math.min(d.left + dx, window.innerWidth - BUTTON)),
        top: Math.max(88, Math.min(d.top + dy, window.innerHeight - BUTTON)),
      });
    };
    const onUp = () => { drag.current = null; document.body.style.userSelect = ''; };
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

  const launcher = useCallback((name: LauncherName): LauncherProps => {
    const offset = (expanded ? EXPANDED : COLLAPSED)[name];
    return {
      ref: buttonRefs.current[name],
      style: {
        left: 0, top: 0,
        zIndex: 100 + (expanded ? 1 : name === 'foamy' ? 3 : name === 'claude' ? 2 : 1),
        transform: `translate(${anchor.left + offset.left}px, ${anchor.top + offset.top}px)`,
        willChange: 'transform',
      },
      onMouseDown: event => {
        event.preventDefault();
        dragged.current = false;
        drag.current = { x: event.clientX, y: event.clientY, left: anchor.left, top: anchor.top, moved: false };
        document.body.style.userSelect = 'none';
      },
      onMouseEnter: enter,
      onMouseLeave: leave,
      isClick: () => {
        const clicked = !dragged.current;
        dragged.current = false;
        return clicked;
      },
    };
  }, [anchor, enter, expanded, leave]);

  const value = useMemo(() => ({ launcher }), [launcher]);
  return <LauncherContext.Provider value={value}>{children}</LauncherContext.Provider>;
}

export function useAgentLauncher(name: LauncherName): LauncherProps {
  const context = useContext(LauncherContext);
  if (!context) throw new Error('useAgentLauncher must be used inside AgentLauncherProvider.');
  return context.launcher(name);
}
