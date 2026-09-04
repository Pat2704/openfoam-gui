'use client';

/**
 * Boundary-condition validation for a case.
 *
 * Lifted out of the Monitor tab: it reports on the mesh's patches, so it sits
 * with the 3D view rather than with the solver logs. Self-contained state, so
 * changing case clears it.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Shield, CheckCircle2, XCircle as XCircleIcon, AlertTriangle, Loader2 } from 'lucide-react';

interface BCData {
  success: boolean;
  fields: { name: string; patches: { patch: string; type: string; valid: boolean; note?: string }[] }[];
  meshPatches: string[];
  warnings: string[];
}

export default function BCValidationPanel({ caseName }: { caseName: string }) {
  const [bcResult, setBcResult] = useState<BCData | null>(null);
  const [bcLoading, setBcLoading] = useState(false);
  const [showBC, setShowBC] = useState(false);

  /**
   * The case this panel is showing right now.
   *
   * The check is a WSL round trip of several seconds, and its result used to be
   * stored unconditionally when it came back — so switching case while one was
   * running dropped the OLD case's verdict into the NEW case's panel, under the
   * new case's name, with nothing to indicate it. The reset effect below could
   * not help: it runs at the moment of the switch, and the stale response
   * arrives after it.
   */
  const currentCaseRef = useRef(caseName);

  const validateBCAction = useCallback(async () => {
    if (!caseName) return;
    setBcLoading(true);
    setShowBC(true);
    setBcResult(null);
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}?action=validateBC`);
      const raw = await res.json();
      // The user moved on while this was in flight; this answer is about a case
      // that is no longer on screen.
      if (currentCaseRef.current !== caseName) return;
      // Normalise before it reaches state. On any server-side failure the route
      // answers `{ error: "…" }` — no `fields`, no `meshPatches`, and crucially
      // no `warnings` — and the render below reads `bcResult.warnings.length`
      // unconditionally. Storing the error object therefore threw a TypeError
      // out of render and took the whole tab down through the error boundary:
      // the user asked for a check and the app disappeared. Anything unexpected
      // now becomes a well-formed "it failed, here is why" result.
      const data: BCData = (raw && Array.isArray(raw.fields) && Array.isArray(raw.warnings) && Array.isArray(raw.meshPatches))
        ? raw
        : { success: false, fields: [], meshPatches: [], warnings: [String(raw?.error || 'The boundary-condition check could not be run.')] };
      setBcResult(data);
      if (!data.success) {
        toast.error(data.warnings[0] || 'BC validation failed');
      } else {
        const totalPatches = data.fields.reduce((s: number, f: BCData['fields'][number]) => s + f.patches.length, 0);
        const invalidPatches = data.fields.reduce(
          (s: number, f: BCData['fields'][number]) => s + f.patches.filter(p => !p.valid).length, 0);
        if (invalidPatches === 0) toast.success('All BCs are valid');
        else toast.warning(`${invalidPatches}/${totalPatches} BCs have issues`);
      }
    } catch {
      toast.error('Error during validation');
      setBcResult({ success: false, fields: [], meshPatches: [], warnings: ['Network error'] });
    }
    setBcLoading(false);
  }, [caseName]);

  useEffect(() => {
    currentCaseRef.current = caseName;
    setShowBC(false);
    setBcResult(null);
    // Also clear the spinner: a check whose answer is discarded as stale would
    // otherwise leave the panel looking busy for ever.
    setBcLoading(false);
  }, [caseName]);

  if (!caseName) return null;

  return (
    <>
  {/* ═══ BC Validation ═══ */}
  <Card>
    <CardHeader className="pb-2 pt-3 px-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <CardTitle className="text-sm flex items-center gap-1.5">
          <Shield className="w-4 h-4" /> Boundary Conditions Validation
        </CardTitle>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="h-7 text-xs"
            onClick={validateBCAction} disabled={bcLoading}>
            {bcLoading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Shield className="w-3 h-3 mr-1" />}
            Validate BC
          </Button>
          {bcResult && (
            <Button size="sm" variant={showBC ? 'default' : 'outline'} className="h-7 text-xs"
              onClick={() => setShowBC(!showBC)}>
              {showBC ? 'Hide' : 'Show'} Result
            </Button>
          )}
        </div>
      </div>
    </CardHeader>
    {showBC && bcResult && (
      <CardContent className="px-3 pb-3">
        {/* Warnings */}
        {bcResult.warnings.length > 0 && (
          <div className="mb-3 space-y-1">
            {bcResult.warnings.map((w, i) => (
              <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 rounded text-xs bg-amber-500/10 text-amber-400 border border-amber-500/20">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{w}</span>
              </div>
            ))}
          </div>
        )}

        {bcResult.fields.length === 0 && bcResult.warnings.length === 0 && (
          <div className="text-xs text-muted-foreground text-center py-2">No fields found in 0/</div>
        )}

        {bcResult.fields.map((field) => {
          const invalidCount = field.patches.filter(p => !p.valid).length;
          return (
            <div key={field.name} className="mb-3 last:mb-0">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-xs font-mono font-semibold">{field.name}</span>
                <Badge variant={invalidCount === 0 ? 'secondary' : 'destructive'} className="text-[9px]">
                  {invalidCount === 0 ? 'OK' : `${invalidCount} issue(s)`}
                </Badge>
              </div>
              <div className="space-y-0.5">
                {field.patches.map((p, i) => (
                  <div key={i} className={`flex items-center gap-2 px-2 py-1 rounded text-[11px] ${
                    !p.valid
                      ? 'bg-red-500/10 border border-red-500/20'
                      : 'bg-muted/30'
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${p.valid ? 'bg-green-500' : 'bg-red-500'}`} />
                    <span className="font-mono font-medium w-28 truncate flex-shrink-0" title={p.patch}>{p.patch}</span>
                    <span className="font-mono text-muted-foreground flex-1 truncate" title={p.type}>{p.type}</span>
                    {p.note && (
                      // A note is not always a complaint: a patch covered by a
                      // pattern or a group carries one too, and painting that
                      // red made a healthy case look broken.
                      <span className={`text-[10px] flex-shrink-0 ${p.valid ? "text-muted-foreground" : "text-red-400"}`}>
                        {p.note}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}

        {bcResult.meshPatches.length > 0 && (
          <div className="mt-2 pt-2 border-t">
            <p className="text-[10px] text-muted-foreground">
              Patches in mesh: <span className="font-mono">{bcResult.meshPatches.join(', ')}</span>
            </p>
          </div>
        )}
      </CardContent>
    )}
  </Card>
    </>
  );
}
