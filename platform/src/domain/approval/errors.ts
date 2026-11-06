import { PlatformError } from '../platform-error.ts'

const HTTP_FORBIDDEN = 403
const HTTP_SERVICE_UNAVAILABLE = 503

// An approval that ends with an HTTP status: refused for good, or not completed and retryable.
export abstract class ApprovalError extends PlatformError {
	abstract readonly status: number
}

export class ApprovalDenied extends ApprovalError {
	readonly status = HTTP_FORBIDDEN
}

export class ApprovalUnavailable extends ApprovalError {
	readonly status = HTTP_SERVICE_UNAVAILABLE
}
