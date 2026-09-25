import { requireUser } from "@/lib/require-user";
import { parseInput, type ParseInput } from "@/lib/parse";

const MAX_FILE_BYTES = 8 * 1024 * 1024; // matches typical serverless body limits

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if ("unauthorized" in auth) return auth.unauthorized;

  const contentType = request.headers.get("content-type") ?? "";

  let input: ParseInput;
  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return Response.json({ error: "file is required for multipart input" }, { status: 400 });
      }
      if (file.size > MAX_FILE_BYTES) {
        return Response.json(
          { error: `File too large — max ${MAX_FILE_BYTES / (1024 * 1024)}MB` },
          { status: 413 },
        );
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      const base64 = buffer.toString("base64");

      if (file.type === "application/pdf") {
        input = { kind: "pdf", base64 };
      } else if (IMAGE_TYPES.has(file.type)) {
        input = { kind: "image", base64, mediaType: file.type as "image/jpeg" | "image/png" | "image/gif" | "image/webp" };
      } else {
        return Response.json({ error: `Unsupported file type: ${file.type}` }, { status: 400 });
      }
    } else {
      const body = await request.json().catch(() => null);
      if (typeof body?.text !== "string" || body.text.trim().length === 0) {
        return Response.json({ error: "text is required" }, { status: 400 });
      }
      input = { kind: "text", text: body.text };
    }
  } catch (err) {
    console.error("[parse] failed to read request body", err);
    return Response.json({ error: "Could not read request body" }, { status: 400 });
  }

  try {
    const result = await parseInput(auth.userId, input, "extension");
    return Response.json({
      intent: result.intent,
      actions: result.actions,
      answer: result.answer,
      answerLead: result.answerLead,
      queryEvents: result.queryEvents,
      usedLLM: result.usedLlm,
      inputType: result.inputType,
    });
  } catch (err) {
    console.error("[parse] failed", err);
    return Response.json({ error: "Parsing failed" }, { status: 500 });
  }
}
