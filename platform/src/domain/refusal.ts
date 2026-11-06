import { PlatformError } from './platform-error.ts'

// A mistake of the project, as opposed to a fault of the platform. A step program prints
// its message alone and exits 1, and the probe job matches refusals on that message.
export class Refusal extends PlatformError {}
