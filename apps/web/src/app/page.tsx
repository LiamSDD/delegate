import { packageName as runtimePackage } from "@delegate/runtime";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-4 px-6">
      <h1 className="font-serif text-5xl tracking-tight">Delegate</h1>
      <p className="text-lg">Turns a company&apos;s goals into finished, verified work.</p>
      <p className="font-mono text-xs opacity-60">foundation build · {runtimePackage}</p>
    </main>
  );
}
