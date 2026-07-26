/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { verifyRepoBudPackage } from './repobud-package.mts';

const allowStale = process.argv.includes('--allow-stale');
const asJson = process.argv.includes('--json');
const result = await verifyRepoBudPackage({ allowStale });

if (asJson) {
	console.log(JSON.stringify(result, null, 2));
} else {
	console.log(
		`Verified ${result.name} ${result.version} (${result.architectures.join(', ')}) at ` +
		`${result.applicationPath}${result.isCurrent ? '' : ' [stale source commit]'}`
	);
}
