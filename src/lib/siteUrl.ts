/** Turn a host or absolute URL into an absolute URL with a protocol. */
export function absoluteSiteUrl(
  value: string | undefined,
  fallback: string,
): string {
  const raw = (value || fallback).trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw.replace(/^\/+/, "")}`;
}
