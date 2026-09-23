"use client";

import { useState } from "react";

// Colors are hardcoded here (not global CSS variables) deliberately — this
// dark palette is specific to the marketing page. /settings and the rest of
// the app keep their own light/auto theme untouched.
//
// Brand palette (matches the calendar+spark mark in /public/brand).
const BG = "#09090b";
const FG = "#f4f4f5";
const MUTED = "#a1a1aa";
const BORDER = "rgba(255,255,255,0.08)";
const SURFACE = "rgba(255,255,255,0.03)";
const ACCENT = "#2075fe";
const ACCENT_RGB = "32,117,254";

const PILLARS: Array<{ title: string; tagline: string; description: string }> = [
  {
    title: "Multimodal capture",
    tagline: "Sentence, screenshot, or entire page.",
    description:
      "Type it, paste a screenshot, or upload a flyer or PDF — one event or twenty, in one shot. “Every Monday at 9am for 8 weeks” becomes a single recurring series, not eight separate events.",
  },
  {
    title: "Smart safeguards",
    tagline: "Zero ghost bookings.",
    description:
      "Every write is confirmed before it happens, and a new event that overlaps something you already have gets flagged before you confirm — not after.",
  },
  {
    title: "Natural calendar chat",
    tagline: "Query your day.",
    description:
      "“What's on Saturday?” gets a real answer read straight from your calendar. “Cancel my dentist appointment” finds the real event and confirms before touching it.",
  },
];

const STEPS = [
  { label: "Type", detail: "Doctor's appointment at 9am tomorrow" },
  { label: "Confirm", detail: "Review the parsed date, time, and title" },
  { label: "Done", detail: "It's on your real Google Calendar" },
];

const DEMOS = [
  {
    id: "text",
    label: "Text Prompt",
    caption: "“Dentist appointment at 2pm tomorrow”",
    src: "/demo/panel-demo-text.webm",
    poster: "/demo/panel-demo-text-poster.jpg",
  },
  {
    id: "flyer",
    label: "Flyer Scan",
    caption: "A season schedule photo becomes a whole confirm list",
    src: "/demo/panel-demo-flyer.webm",
    poster: "/demo/panel-demo-flyer-poster.jpg",
  },
  {
    id: "page",
    label: "Page Detection",
    caption: "One click scans the page you're on for an event",
    src: "/demo/panel-demo-page.webm",
    poster: "/demo/panel-demo-page-poster.jpg",
  },
];

function Logo({ size = 28 }: { size?: number }) {
  // eslint-disable-next-line @next/next/no-img-element -- fixed-size brand mark, not a content image
  return <img src="/brand/icon-mark.png" width={size} height={size} alt="" aria-hidden="true" />;
}

function TransformChip() {
  return (
    <div className="flex flex-col items-center gap-2 text-sm sm:flex-row">
      <span className="rounded-full border px-4 py-2" style={{ borderColor: BORDER, background: SURFACE, color: MUTED }}>
        “Dentist next Tuesday at 3pm”
      </span>
      <span style={{ color: MUTED }} aria-hidden="true">
        →
      </span>
      <span
        className="rounded-full border px-4 py-2 font-mono"
        style={{ borderColor: `rgba(${ACCENT_RGB},0.4)`, background: `rgba(${ACCENT_RGB},0.1)`, color: FG }}
      >
        🦷 Dentist · Tue, Oct 14 · 3:00 PM
      </span>
    </div>
  );
}

function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (status === "loading") return;
    setStatus("loading");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setStatus(res.ok ? "done" : "error");
    } catch {
      setStatus("error");
    }
  }

  if (status === "done") {
    return (
      <p
        className="rounded-full border px-5 py-2.5 text-sm"
        style={{ borderColor: `rgba(${ACCENT_RGB},0.4)`, background: `rgba(${ACCENT_RGB},0.1)`, color: FG }}
      >
        You&rsquo;re on the list — we&rsquo;ll email you when there&rsquo;s news.
      </p>
    );
  }

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-2">
      <form onSubmit={handleSubmit} className="flex w-full flex-col gap-2 sm:flex-row">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Enter your email"
          className="flex-1 rounded-full border px-4 py-2.5 text-sm outline-none"
          style={{ borderColor: BORDER, background: SURFACE, color: FG }}
        />
        <button
          type="submit"
          disabled={status === "loading"}
          className="rounded-full px-5 py-2.5 text-sm font-medium text-white disabled:opacity-60"
          style={{ background: ACCENT }}
        >
          {status === "loading" ? "Joining…" : "Join the waitlist"}
        </button>
      </form>
      {status === "error" && <p className="text-xs text-red-400">Couldn&rsquo;t save that — try again?</p>}
    </div>
  );
}

function DemoShowcase() {
  const [active, setActive] = useState(0);
  const demo = DEMOS[active];

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex gap-1 rounded-full border p-1 text-sm" style={{ borderColor: BORDER, background: SURFACE }}>
        {DEMOS.map((d, i) => (
          <button
            key={d.id}
            onClick={() => setActive(i)}
            className="rounded-full px-3.5 py-1.5 transition-colors"
            style={i === active ? { background: ACCENT, color: "#fff" } : { color: MUTED }}
          >
            {d.label}
          </button>
        ))}
      </div>

      <div className="relative">
        <div
          className="pointer-events-none absolute -inset-8 -z-10 rounded-full blur-3xl"
          style={{ background: `rgba(${ACCENT_RGB},0.2)` }}
          aria-hidden="true"
        />
        <div className="mx-auto max-w-xs overflow-hidden rounded-2xl border bg-black shadow-2xl" style={{ borderColor: BORDER }}>
          <div className="flex items-center gap-1.5 border-b px-3 py-2" style={{ borderColor: BORDER }}>
            <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
            <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
            <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          </div>
          <video key={demo.id} className="w-full" src={demo.src} poster={demo.poster} autoPlay loop muted playsInline />
        </div>
      </div>
      <p className="text-center text-sm" style={{ color: MUTED }}>
        {demo.caption}
      </p>
    </div>
  );
}

function TypeVisual() {
  return (
    <div
      className="flex items-center gap-1 rounded-lg border px-3 py-2.5 font-mono text-xs"
      style={{ borderColor: BORDER, background: SURFACE, color: FG }}
    >
      <span>Doctor&rsquo;s appointment at 9am tomorrow</span>
      <span className="h-3.5 w-px animate-pulse" style={{ background: ACCENT }} aria-hidden="true" />
    </div>
  );
}

function ConfirmVisual() {
  return (
    <div className="flex items-center gap-2 rounded-lg border px-3 py-2.5" style={{ borderColor: BORDER, background: SURFACE }}>
      <span
        className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-[10px] text-white"
        style={{ background: ACCENT }}
      >
        ✓
      </span>
      <span className="text-xs" style={{ color: FG }}>
        Doctor&rsquo;s appointment
      </span>
      <span className="ml-auto font-mono text-[10px]" style={{ color: MUTED }}>
        9:00 AM
      </span>
    </div>
  );
}

function DoneVisual() {
  const cells = Array.from({ length: 7 });
  return (
    <div className="grid grid-cols-7 gap-1 rounded-lg border px-3 py-2.5" style={{ borderColor: BORDER, background: SURFACE }}>
      {cells.map((_, i) => (
        <span key={i} className="h-4 rounded-sm" style={{ background: i === 3 ? ACCENT : "rgba(255,255,255,0.1)" }} />
      ))}
    </div>
  );
}

const STEP_VISUALS = [TypeVisual, ConfirmVisual, DoneVisual];

export default function Home() {
  return (
    <main className="flex min-h-screen flex-1 flex-col" style={{ background: BG, color: FG }}>
      <header className="mx-auto flex w-full max-w-5xl items-center gap-2 px-6 py-6">
        <Logo size={24} />
        <span className="text-sm font-semibold tracking-tight">kinroo.ai</span>
      </header>

      <section className="mx-auto flex w-full max-w-3xl flex-col items-center gap-6 px-6 pt-12 pb-16 text-center">
        <Logo size={56} />
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Plain English, straight onto your calendar
        </h1>
        <p className="max-w-xl text-lg" style={{ color: MUTED }}>
          Turn natural text, screenshots, and flyer photos into Google Calendar events. Always
          verified before saving.
        </p>
        <TransformChip />
        <WaitlistForm />
      </section>

      <section className="mx-auto w-full max-w-3xl px-6 pb-20">
        <DemoShowcase />
      </section>

      <section className="mx-auto w-full max-w-3xl px-6 pb-16">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {STEPS.map((step, i) => {
            const Visual = STEP_VISUALS[i];
            return (
              <div key={step.label} className="flex flex-col gap-3 rounded-xl border p-5" style={{ borderColor: BORDER }}>
                <span className="font-mono text-xs font-semibold" style={{ color: ACCENT }}>{`0${i + 1}`}</span>
                <span className="font-medium">{step.label}</span>
                <Visual />
                <span className="text-sm" style={{ color: MUTED }}>
                  {step.detail}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl px-6 pb-20">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          {PILLARS.map((pillar) => (
            <div key={pillar.title} className="flex flex-col gap-2 rounded-xl border p-6" style={{ borderColor: BORDER }}>
              <h3 className="font-medium">{pillar.title}</h3>
              <p className="text-sm font-medium" style={{ color: ACCENT }}>
                {pillar.tagline}
              </p>
              <p className="text-sm" style={{ color: MUTED }}>
                {pillar.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      <footer className="mx-auto flex w-full max-w-5xl flex-col items-center gap-3 px-6 pb-10">
        <p className="inline-block rounded-full border px-4 py-2 text-xs" style={{ borderColor: BORDER, background: SURFACE, color: MUTED }}>
          Zero event persistence: kinroo reads and writes through Google APIs on your command.
          Your schedule never touches our servers.
        </p>
        <a href="/privacy" className="text-xs underline" style={{ color: MUTED }}>
          Privacy Policy
        </a>
      </footer>
    </main>
  );
}
