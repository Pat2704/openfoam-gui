'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { AlertTriangle, RotateCcw, Home } from 'lucide-react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[OpenFOAM Studio] Unhandled error:', error);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-5">
        <div className="mx-auto w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center">
          <AlertTriangle className="w-8 h-8 text-destructive" />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-xl font-semibold tracking-tight">
            Something went wrong
          </h2>
          <p className="text-sm text-muted-foreground">
            An unexpected error occurred in the interface. Try again or
            return to the dashboard.
          </p>
        </div>
        {error?.message && (
          <pre className="text-[11px] font-mono text-left bg-muted/60 border border-border rounded-lg p-3 overflow-x-auto max-h-32">
            {error.message}
          </pre>
        )}
        <div className="flex items-center justify-center gap-2 pt-1">
          <Button onClick={reset} size="sm" className="gap-1.5">
            <RotateCcw className="w-3.5 h-3.5" />
            Try again
          </Button>
          <Button
            // A FULL reload, deliberately, and not router.push('/').
            //
            // This is the error boundary: we are here because the React tree
            // threw, and a client-side navigation keeps that same tree — along
            // with whatever state got it into this condition. "Try again" beside
            // it is already the soft path (`reset()` re-renders the segment);
            // this button is the one the user reaches for when that did not
            // work, and its value is precisely that it throws everything away.
            // eslint-disable-next-line @next/next/no-location-assign-relative-destination
            onClick={() => { window.location.href = '/'; }}
            variant="outline"
            size="sm"
            className="gap-1.5"
          >
            <Home className="w-3.5 h-3.5" />
            Home
          </Button>
        </div>
      </div>
    </div>
  );
}
