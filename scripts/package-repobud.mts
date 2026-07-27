/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { runRequiredProcess } from './repobud-launch.mts';
import {
	repositoryRoot,
	resolvePackagePaths,
	verifyRepoBudPackage,
} from './repobud-package.mts';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
	throw new Error('The initial RepoBud package target requires macOS on Apple silicon.');
}

const processOptions = { cwd: repositoryRoot };

await runRequiredProcess(process.execPath, [
	'--experimental-strip-types',
	'--max-old-space-size=8192',
	join(repositoryRoot, 'node_modules', 'gulp', 'bin', 'gulp.js'),
	'vscode-darwin-arm64',
], processOptions);

const packagePaths = resolvePackagePaths();
const product = JSON.parse(await readFile(join(repositoryRoot, 'product.json'), 'utf8'));
await runRequiredProcess('/usr/bin/plutil', [
	'-replace',
	'LSMinimumSystemVersion',
	'-string',
	product.darwinMinimumSystemVersion,
	packagePaths.infoPlistPath,
], processOptions);
for (const privacyKey of product.darwinRemovedPrivacyUsageDescriptions) {
	spawnSync('/usr/libexec/PlistBuddy', [
		'-c',
		`Delete :${privacyKey}`,
		packagePaths.infoPlistPath,
	], { stdio: 'ignore' });
}
await runRequiredProcess('/usr/bin/codesign', [
	'--force',
	'--deep',
	'--sign',
	'-',
	'--preserve-metadata=entitlements',
	packagePaths.applicationPath,
], processOptions);

const result = await verifyRepoBudPackage();
console.log(`Packaged ${result.name} at ${result.applicationPath}`);
