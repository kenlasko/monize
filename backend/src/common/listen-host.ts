/**
 * Resolve the optional `HOST` environment variable: the single interface the
 * backend listener binds to. Unset, empty and whitespace-only all mean "not
 * set", so `app.listen(port)` keeps its all-interfaces default and container
 * deployments behave exactly as before. The desktop build sets `127.0.0.1`.
 */
export function resolveListenHost(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
