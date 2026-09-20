import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { settings, users } from "@/lib/db/schema";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/session";
import { SettingsForm } from "./settings-form";

function Message({ text }: { text: string }) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <p className="text-sm text-gray-500">{text}</p>
    </main>
  );
}

export default async function SettingsPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const userId = token ? await verifySessionToken(token) : null;

  if (!userId) {
    return <Message text='Open this page from the "Settings" link in the kinroo.ai extension popup to sign in.' />;
  }

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const [row] = await db.select().from(settings).where(eq(settings.userId, userId)).limit(1);

  if (!user || !row) {
    return <Message text="Could not load your account. Try reopening this page from the extension." />;
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-gray-500">Signed in as {user.email}</p>
      </div>
      <SettingsForm
        initial={{
          timezone: row.timezone,
          defaultEventDurationMin: row.defaultEventDurationMin,
          defaultCalendarId: row.defaultCalendarId,
          confirmBeforeWrite: row.confirmBeforeWrite,
        }}
      />
    </main>
  );
}
