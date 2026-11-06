// What Wrangler reported for the upload of the environment's Worker: a version that waits
// for its promotion, or a deployment that already serves on its targets.
export type Upload =
	| { kind: 'version'; version: string; previewUrl: string }
	| { kind: 'direct'; targets: readonly string[] }

// The uploaded version, empty when the Worker was deployed directly and already serves,
// and the URL the smoke request targets.
export type DeploymentRecord = { version: string; url: string }

export function recordDeployment(
	upload: Upload,
	domain: string,
): DeploymentRecord {
	if (upload.kind === 'version')
		return { version: upload.version, url: upload.previewUrl }
	// The health check targets the workers.dev URL when there is one, else the declared domain.
	return {
		version: '',
		url:
			upload.targets.find(target => target.endsWith('.workers.dev')) ??
			`https://${domain}`,
	}
}
