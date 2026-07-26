/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Repository Context Workbench contributors.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { verifyRepositoryContextPackage } from './repository-context-package.mjs';

const allowStale = process.argv.includes('--allow-stale');
const asJson = process.argv.includes('--json');
const result = await verifyRepositoryContextPackage({ allowStale });

if (asJson) {
	console.log(JSON.stringify(result, null, 2));
} else {
	console.log(
		`Verified ${result.name} ${result.version} (${result.architectures.join(', ')}) at ` +
		`${result.applicationPath}${result.isCurrent ? '' : ' [stale source commit]'}`
	);
}
