/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import {
	createGitManifestInventory,
	diffGitManifestInventories,
} from './git-command-inventory.mts';

/**
 * Creates the minimum Git extension manifest needed by inventory tests.
 */
function manifest(commands, menus) {
	return {
		contributes: {
			commands: commands.map(command => ({ command })),
			menus: {
				'scm/title': menus.map(command => ({
					command,
					group: 'navigation',
					when: 'scmProvider == git',
				})),
			},
		},
	};
}

const baseline = createGitManifestInventory(
	manifest(['git.commit', 'git.fetch'], ['git.commit'])
);
const candidate = createGitManifestInventory(
	manifest(['git.commit', 'git.push'], ['git.push'])
);
const delta = diffGitManifestInventories(baseline, candidate);

assert.deepEqual(delta.addedCommands, ['git.push']);
assert.deepEqual(delta.removedCommands, ['git.fetch']);
assert.deepEqual(delta.addedMenus.map(entry => entry.command), ['git.push']);
assert.deepEqual(delta.removedMenus.map(entry => entry.command), ['git.commit']);
assert.notEqual(baseline.commandHash, candidate.commandHash);
assert.notEqual(baseline.menuHash, candidate.menuHash);
console.log('Git command inventory delta test passed.');
