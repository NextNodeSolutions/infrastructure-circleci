// The Cloudflare resources of one environment of one project. Each resource kind is
// keyed by an entry of nextnode.toml, carried by the spec. The program runs inline in
// the driver's process, so it keeps everything inside this function.
import * as cloudflare from '@pulumi/cloudflare'

import { zoneForDomain } from './zone-for-domain.ts'

import type { Spec } from './spec.ts'

export async function program(
	spec: Spec,
	accountId: string,
): Promise<Record<string, unknown>> {
	const zone = zoneForDomain(accountId, spec.domain)

	// The environment's domain, attached to the Worker Wrangler has just uploaded. The
	// driver runs after that upload, so the Worker exists before the domain names it.
	// A hostname holds one custom domain and a new service replaces the resource, so the
	// old attachment is deleted first.
	new cloudflare.WorkersCustomDomain(
		'domain',
		{
			accountId,
			zoneId: zone.id,
			hostname: spec.domain,
			service: spec.worker_name,
		},
		{ deleteBeforeReplace: true },
	)

	return { domain: spec.domain, zone: zone.name }
}
