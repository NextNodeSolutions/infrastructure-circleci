import { sep } from 'node:path'

export function within(root: string, path: string): boolean {
	return path === root || path.startsWith(root + sep)
}
