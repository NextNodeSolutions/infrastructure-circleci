// The repository name names the Pulumi project, the vault project and, suffixed with the
// environment, the Worker, which Cloudflare restricts to lowercase letters, digits and dashes.
export const PROJECT_NAME = /^[a-z0-9][a-z0-9-]*$/
