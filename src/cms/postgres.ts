/**
 * Neon copies `sslmode=require` and often `channel_binding=require`.
 * Rewriting that to `verify-full` makes the pg handshake stall from Vercel
 * until the function is killed. Keep require, and drop channel binding.
 */
export function postgresConnectionString(): string {
  const raw = process.env.POSTGRES_URL || process.env.DATABASE_URI || "";
  if (!raw) return "";

  try {
    const url = new URL(raw);
    url.searchParams.delete("channel_binding");
    const mode = (url.searchParams.get("sslmode") || "").toLowerCase();
    if (!mode || mode === "prefer" || mode === "require" || mode === "verify-ca") {
      url.searchParams.set("sslmode", "require");
    }
    return url.toString();
  } catch {
    return raw
      .replace(/([?&])channel_binding=[^&]*&?/gi, "$1")
      .replace(/[?&]$/, "");
  }
}
