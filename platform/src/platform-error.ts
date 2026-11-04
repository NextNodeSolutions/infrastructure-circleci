export class PlatformError extends Error {
  static describe(error: unknown, otherwise: string): string {
    return error instanceof PlatformError ? error.message : otherwise;
  }
}
