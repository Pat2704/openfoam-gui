import { Waves } from 'lucide-react';

export default function Loading() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <div className="relative w-12 h-12">
          <div className="absolute inset-0 rounded-full border-2 border-muted" />
          <div className="absolute inset-0 rounded-full border-2 border-primary border-t-transparent animate-spin" />
          <Waves className="absolute inset-0 m-auto w-5 h-5 text-primary/70" />
        </div>
        <p className="text-sm font-medium">Loading…</p>
      </div>
    </div>
  );
}
