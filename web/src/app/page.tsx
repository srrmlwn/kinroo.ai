export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <h1 className="text-2xl font-semibold">kinroo.ai</h1>
      <p className="text-sm text-gray-500">
        Backend + onboarding for the kinroo Chrome extension. See{" "}
        <code>SPEC.md</code> at the repo root.
      </p>
    </main>
  );
}
