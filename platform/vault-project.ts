// Finds the vault project named after the repository among the projects the job's
// identity belongs to, and prints its id. The identity is a member of every application
// project, so the name is what keeps a project away from another's secrets. The vault
// token comes from the environment, never from an argument.
//
//   INFISICAL_TOKEN=... node vault-project.ts --name <repository>
import { parseArgs } from 'node:util'

import * as v from 'valibot'

import { RecordSchema } from './src/record.ts'

const { values: args } = parseArgs({ options: { name: { type: 'string' } } })
if (!args.name) throw new Error('usage: vault-project.ts --name <repository>')
const token = process.env.INFISICAL_TOKEN
if (!token) throw new Error('INFISICAL_TOKEN is not set')

const domain = process.env.INFISICAL_DOMAIN
if (!domain) throw new Error('INFISICAL_DOMAIN is not set')
const response = await fetch(`${domain}/v1/workspace`, {
	headers: { authorization: `Bearer ${token}` },
	redirect: 'error',
})
if (!response.ok)
	throw new Error(
		`the vault refused the project listing (HTTP ${response.status})`,
	)
const body: unknown = await response.json()
const projects =
	v.is(RecordSchema, body) && Array.isArray(body.workspaces)
		? body.workspaces.filter(entry => v.is(RecordSchema, entry))
		: []
const named = projects.filter(
	project => project.name === args.name && project.type === 'secret-manager',
)
const id = named[0]?.id
if (named.length !== 1 || typeof id !== 'string') {
	throw new Error(
		`the identity belongs to ${named.length} vault project(s) named ${args.name}: expected exactly one, named after the repository`,
	)
}
process.stdout.write(id)
