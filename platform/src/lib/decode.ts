import * as v from 'valibot'

// Parses the input with the schema, or throws the error the caller builds from the list of
// the failing fields; a failure of the whole input is named as the caller says.
export function decodeOr<TSchema extends v.GenericSchema>(
	schema: TSchema,
	input: unknown,
	fail: (fields: string) => Error,
	whole = 'response',
): v.InferOutput<TSchema> {
	const parsed = v.safeParse(schema, input)
	if (!parsed.success)
		throw fail(
			parsed.issues.map(issue => v.getDotPath(issue) ?? whole).join(', '),
		)
	return parsed.output
}
