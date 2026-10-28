import { fileURLToPath } from 'node:url'

if (process.env.NODE_ENV === 'production' || process.env.CI === 'true') {
	process.exit(0)
}
const husky = (await import('husky')).default
process.chdir(fileURLToPath(new URL('../..', import.meta.url)))
process.stdout.write(husky('platform/.husky'))
