// API error shapes and status-to-exit mapping (API-01, API-02).

/** The wire shape of every error body: `{"error": {"code", "message", ...details}}`. */
export interface ErrorBody {
	error: {
		code: string;
		message: string;
		[detail: string]: unknown;
	};
}

/**
 * An error carrying an HTTP status and a stable code. The server renders it as an ErrorBody
 * and the CLI maps its status to an exit code (API-02).
 */
export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details: Record<string, unknown>;

	constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
		this.details = details;
	}

	toBody(): ErrorBody {
		return { error: { code: this.code, message: this.message, ...this.details } };
	}

	static badRequest(code: string, message: string, details?: Record<string, unknown>): ApiError {
		return new ApiError(400, code, message, details);
	}
	static notFound(message: string, details?: Record<string, unknown>): ApiError {
		return new ApiError(404, "not_found", message, details);
	}
	static stale(message: string, details?: Record<string, unknown>): ApiError {
		return new ApiError(409, "stale", message, details);
	}
	static overBudget(message: string, details?: Record<string, unknown>): ApiError {
		return new ApiError(402, "over_budget", message, details);
	}
	static forbidden(message: string, details?: Record<string, unknown>): ApiError {
		return new ApiError(403, "forbidden", message, details);
	}
	static unauthorized(message: string, details?: Record<string, unknown>): ApiError {
		return new ApiError(403, "unauthorized", message, details);
	}
	static notImplemented(message: string, details?: Record<string, unknown>): ApiError {
		return new ApiError(501, "not_implemented", message, details);
	}
}

/**
 * Map an HTTP status to a CLI exit code (API-02):
 * 2xx → 0, 400 → 2, 402 → 5, 404 → 4, 409 → 3, any other non-2xx → 1.
 */
export function statusToExitCode(status: number): number {
	if (status >= 200 && status < 300) return 0;
	switch (status) {
		case 400:
			return 2;
		case 402:
			return 5;
		case 404:
			return 4;
		case 409:
			return 3;
		default:
			return 1;
	}
}
