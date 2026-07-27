/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import {
	applicationDataArguments,
	prepareApplicationData,
	runProcess,
} from './repobud-launch.mts';
import { verifyRepoBudPackage } from './repobud-package.mts';

const previewDataRoot = process.env.REPOBUD_PREVIEW_DATA_DIR ??
	join(homedir(), '.repobud-preview');
const allowStale = process.argv.includes('--allow-stale');
const applicationArgs = process.argv.slice(2).filter(argument => argument !== '--allow-stale');

const applicationData = await prepareApplicationData(previewDataRoot);
const packaged = await verifyRepoBudPackage({ allowStale });
const launchArguments = [
	'-n',
	packaged.applicationPath,
	'--args',
	...applicationDataArguments(applicationData),
	'--disable-workspace-trust',
	...applicationArgs,
];

console.log(`Opening ${packaged.name} with preview data at ${previewDataRoot}`);
process.exitCode = await runProcess('/usr/bin/open', launchArguments);
