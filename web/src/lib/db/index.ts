import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

// Lazy: Next.js evaluates route modules at build time to collect page data,
// which would throw here if DATABASE_URL isn't set in the build environment.
// Deferring instantiation to first real use keeps the build env-independent.
let instance: NeonHttpDatabase<typeof schema> | null = null;

function getDb(): NeonHttpDatabase<typeof schema> {
  if (!instance) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    instance = drizzle(neon(url), { schema });
  }
  return instance;
}

export const db: NeonHttpDatabase<typeof schema> = new Proxy(
  {} as NeonHttpDatabase<typeof schema>,
  {
    get(_target, prop, receiver) {
      return Reflect.get(getDb(), prop, receiver);
    },
  },
);
