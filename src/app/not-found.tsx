import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Compass, Home } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-5">
        <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
          <Compass className="w-8 h-8 text-primary" />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-2xl font-bold tracking-tight">404</h2>
          <p className="text-sm text-muted-foreground">
            The page you are looking for does not exist. OpenFOAM Studio only
            exposes the main route.
          </p>
        </div>
        <Button asChild size="sm" className="gap-1.5">
          <Link href="/">
            <Home className="w-3.5 h-3.5" />
            Back to Dashboard
          </Link>
        </Button>
      </div>
    </div>
  );
}
