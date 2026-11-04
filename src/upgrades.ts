/**
 * Upgrade scripts for buttons and triggers made with older versions.
 * Companion runs each script once per connection, in order, and remembers
 * which have run. Add new ones to the end; never remove or reorder them.
 *
 * 0.1.0: the first version, so nothing to upgrade yet. (It was born after
 * "Rider" became "Auto Level", so it never had the old names.)
 */

import type { CompanionStaticUpgradeScript, JsonObject } from '@companion-module/base'

export function upgradeScripts<TConfig extends JsonObject>(): CompanionStaticUpgradeScript<TConfig>[] {
	return []
}
