import type { Metadata } from "next";
import { describe, itemsForLink, loadBatch, verb } from "@/lib/email-batch";
import { verifyUndoLinkToken } from "@/lib/session";
import { getUserSettings } from "@/lib/user-settings";

export const metadata: Metadata = {
  title: "Undo — kinroo.ai",
  robots: { index: false, follow: false },
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-6 py-16 text-sm">
      <h1 className="text-2xl font-semibold">kinroo.ai</h1>
      {children}
    </main>
  );
}

// Landing page for the Remove / Undo links in an auto-apply summary email.
// Shows what the link covers and asks for a click before changing anything
// (see api/email/undo for why the link itself can't do it).
export default async function UndoPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const token = typeof params.t === "string" ? params.t : "";
  const claims = token ? await verifyUndoLinkToken(token) : null;
  if (!claims) {
    return (
      <Shell>
        <p className="text-gray-600">
          This link has expired or isn&rsquo;t valid. You can still change the event in Google Calendar, or reply
          to kinroo&rsquo;s email.
        </p>
      </Shell>
    );
  }
  const batch = await loadBatch(claims.batchId, claims.userId);
  if (!batch) {
    return (
      <Shell>
        <p className="text-gray-600">We couldn&rsquo;t find these changes anymore.</p>
      </Shell>
    );
  }

  const { timezone } = await getUserSettings(claims.userId);
  const items = itemsForLink(batch, claims.item);
  const pending = items.filter((i) => i.status === "applied");
  const reversed = items.filter((i) => i.status === "undone");

  return (
    <Shell>
      {params.done === "1" && <p className="rounded bg-green-50 px-3 py-2 text-green-800">Done — your calendar is updated.</p>}
      {params.failed === "1" && (
        <p className="rounded bg-red-50 px-3 py-2 text-red-700">Some of these couldn&rsquo;t be undone. Try again in a moment.</p>
      )}

      {pending.length > 0 ? (
        <>
          <p className="text-gray-600">
            {claims.item === "all" ? "Undo everything kinroo did from" : "Undo this change from"} &ldquo;
            {batch.subject || "your email"}&rdquo;?
          </p>
          <ul className="flex flex-col gap-1">
            {pending.map((item) => (
              <li key={item.n}>
                <span className="font-medium">{item.n}. </span>
                {item.action.type === "create" ? "Remove" : item.action.type === "update" ? "Revert" : "Restore"}:{" "}
                {describe(item, timezone)}
              </li>
            ))}
          </ul>
          <form method="post" action="/api/email/undo">
            <input type="hidden" name="t" value={token} />
            <button type="submit" className="rounded bg-[#2075fe] px-3 py-2 font-medium text-white">
              {pending.length === 1 ? "Undo" : `Undo ${pending.length} changes`}
            </button>
          </form>
        </>
      ) : (
        params.done !== "1" && <p className="text-gray-600">Nothing left to undo here.</p>
      )}

      {reversed.length > 0 && (
        <ul className="flex flex-col gap-1 text-gray-500">
          {reversed.map((item) => (
            <li key={item.n}>
              {item.n}. {verb(item)}: {describe(item, timezone)}
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
