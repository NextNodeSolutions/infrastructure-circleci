// The platform's own copy of what the upload takes from the checkout. Wrangler runs on it
// with the Cloudflare credential, so it must hold no file the project can point it to.
export type Staging = {
	// Empties the copy, before anything is staged into it.
	clear(): void
	// Copies a directory of the checkout under the given name, refusing every link, and
	// returns the path of the copy.
	stage(directory: string, name: string): string
}
