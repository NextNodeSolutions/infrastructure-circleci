import {
	HTTP_FORBIDDEN,
	HTTP_SERVICE_UNAVAILABLE,
} from '../../lib/http-status.ts'
import { PlatformError } from '../platform-error.ts'

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
