import { getUserId } from "./session";

// Shared guard for route handlers. Returns the authenticated userId, or a
// 401 Response the caller should return immediately.
export async function requireUser(
  request: Request,
): Promise<{ userId: string } | { unauthorized: Response }> {
  const userId = await getUserId(request);
  if (!userId) {
    return {
      unauthorized: Response.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  return { userId };
}
