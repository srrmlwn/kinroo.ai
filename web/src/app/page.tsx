const FEATURES: Array<{ title: string; description: string }> = [
  {
    title: "Compose",
    description:
      "Type it, paste a screenshot, or upload a flyer or PDF. One event or twenty — a season schedule photo becomes a whole confirm list in one shot.",
  },
  {
    title: "Ask",
    description: "“What's on Saturday?” gets a real answer, read straight from your calendar.",
  },
  {
    title: "Edit & cancel",
    description: "“Cancel my dentist appointment” finds the real event and confirms before touching it.",
  },
  {
    title: "Recurring events",
    description: "“Every Monday at 9am for 8 weeks” becomes one series, not eight separate events.",
  },
  {
    title: "Conflict detection",
    description: "A new event that overlaps something you already have gets flagged before you confirm, not after.",
  },
  {
    title: "Detect events on a page",
    description: "One click scans the page you're on for anything that looks like an event.",
  },
];

const STEPS = [
  { label: "Type", detail: "“Doctor's appointment at 9am tomorrow”" },
  { label: "Confirm", detail: "Review the parsed date, time, and title" },
  { label: "Done", detail: "It's on your real Google Calendar" },
];

function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" aria-hidden="true">
      <rect width="128" height="128" rx="28" fill="#1a73e8" />
      <rect x="43" y="19" width="8" height="16" rx="4" fill="#ffffff" />
      <rect x="77" y="19" width="8" height="16" rx="4" fill="#ffffff" />
      <rect x="30" y="33" width="68" height="62" rx="10" fill="#ffffff" />
      <polygon points="99,17 102,25 110,28 102,31 99,39 96,31 88,28 96,25" fill="#ffffff" />
    </svg>
  );
}

export default function Home() {
  return (
    <main className="flex flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-5xl items-center gap-2 px-6 py-6">
        <Logo size={24} />
        <span className="text-sm font-semibold tracking-tight">kinroo.ai</span>
      </header>

      <section className="mx-auto flex w-full max-w-3xl flex-col items-center gap-5 px-6 pt-12 pb-16 text-center">
        <Logo size={56} />
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Plain English, straight onto your calendar
        </h1>
        <p className="max-w-xl text-lg text-gray-500 dark:text-gray-400">
          kinroo.ai is a Chrome extension that turns a sentence, a screenshot, or a flyer photo into
          a Google Calendar event — and answers questions about what's already on it. Nothing is ever
          written without your confirmation.
        </p>
        <p className="text-sm text-gray-400 dark:text-gray-500">
          In private development — not yet on the Chrome Web Store.
        </p>
      </section>

      <section className="mx-auto w-full max-w-3xl px-6 pb-16">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {STEPS.map((step, i) => (
            <div
              key={step.label}
              className="flex flex-col gap-2 rounded-xl border border-gray-200 p-5 dark:border-gray-800"
            >
              <span className="text-xs font-semibold text-[#1a73e8]">{`0${i + 1}`}</span>
              <span className="font-medium">{step.label}</span>
              <span className="text-sm text-gray-500 dark:text-gray-400">{step.detail}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl px-6 pb-20">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="flex flex-col gap-1.5">
              <div className="h-1 w-8 rounded-full bg-[#1a73e8]" />
              <h3 className="font-medium">{feature.title}</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">{feature.description}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="mx-auto w-full max-w-5xl px-6 pb-10 text-xs text-gray-400 dark:text-gray-500">
        Google Calendar is the only place your events live — kinroo never keeps its own copy.
      </footer>
    </main>
  );
}
