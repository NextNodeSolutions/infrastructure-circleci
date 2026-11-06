import * as cloudflare from '@pulumi/cloudflare'

import type * as pulumi from '@pulumi/pulumi'

// The zone is the longest registered name of the account that the domain belongs to.
export function zoneForDomain(
	accountId: string,
	domain: string,
): pulumi.Output<{ id: string; name: string }> {
	return cloudflare
		.getZonesOutput({ account: { id: accountId } })
		.apply(({ results }) => {
			const holding = results.filter(
				zone =>
					domain === zone.name || domain.endsWith(`.${zone.name}`),
			)
			if (!holding.length)
				throw new Error(
					`${domain}: no zone of the account holds this domain`,
				)
			const zone = holding.reduce((longest, zone) =>
				zone.name.length > longest.name.length ? zone : longest,
			)
			return { id: zone.id, name: zone.name }
		})
}
