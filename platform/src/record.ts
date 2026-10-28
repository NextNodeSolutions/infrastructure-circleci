import * as v from 'valibot'

export const RecordSchema = v.custom<Record<string, unknown>>(
	input =>
		typeof input === 'object' && input !== null && !Array.isArray(input),
)
