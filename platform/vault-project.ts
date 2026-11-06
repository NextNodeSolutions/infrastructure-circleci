// Finds the vault project named after the repository among the projects the job's
// identity belongs to, and prints its id. The vault token comes from the environment,
// never from an argument.
//
//   INFISICAL_DOMAIN=... INFISICAL_TOKEN=... node vault-project.ts --name <repository>
import { parseArgs } from 'node:util'

import { env } from './src/adapters/cli.ts'
import { listVaultProjects } from './src/adapters/infisical/projects.ts'
import { findVaultProject } from './src/domain/vault/project.ts'

const { values: args } = parseArgs({ options: { name: { type: 'string' } } })
if (!args.name) throw new Error('usage: vault-project.ts --name <repository>')
const token = env('INFISICAL_TOKEN')
const domain = env('INFISICAL_DOMAIN')

const projects = await listVaultProjects(domain, token)
process.stdout.write(findVaultProject(projects, args.name))
