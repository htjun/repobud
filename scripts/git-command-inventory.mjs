/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Repository Context Workbench contributors.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';

export const pinnedUpstreamInventory = Object.freeze({
	tag: '1.130.0',
	commit: '1b6a188127eeaf9194f945eb6eb89a657e93c54c',
	commandCount: 183,
	commandHash: 'e12896fac37f3780bc30d3248c1cd2c5328f2a6d3498998c36506a0122fb6198',
	menuCount: 420,
	menuHash: 'f874365342e652453f7eabc866116895ae7bbcbb1350ffb2fb19ca745aed07d1',
});

export const downstreamInventory = Object.freeze({
	commandCount: 184,
	commandHash: '75f7421839c861fb0f062804d58fe89ade255561c3033c6419d03da8399dee9f',
	menuCount: 421,
	menuHash: '8eee1eef97ef218bc3d452404b67093569346d11fbe34f880330fa2385296924',
});

export const excludedCommands = new Map([
	['git.acceptMerge', 'Conflict resolution belongs in an external editor.'],
	['git.blame.toggleStatusBarItem', 'The product has no status bar.'],
	['git.close', 'The repository catalog owns active-repository lifecycle.'],
	['git.closeOtherRepositories', 'The product never combines repository trees.'],
	['git.commitMessageAccept', 'Commit-message editor workflows are not part of the viewer.'],
	['git.commitMessageDiscard', 'Commit-message editor workflows are not part of the viewer.'],
	['git.continueInLocalClone', 'Remote edit-session continuation is outside product scope.'],
	['git.delete', 'The viewer does not directly delete source files.'],
	['git.migrateWorktreeChanges', 'Interactive in-app merge editing is outside product scope.'],
	['git.openMergeEditor', 'Conflict resolution belongs in an external editor.'],
	['git.openRepositoriesInParentFolders', 'The repository catalog requires explicit registration.'],
	['git.rename', 'The viewer does not directly rename source files.'],
	['git.reopenClosedRepositories', 'The repository catalog owns active-repository lifecycle.'],
	['git.restoreCommitTemplate', 'Commit-message editor workflows are not part of the viewer.'],
	['git.revertChange', 'Discard is available only through confirmed SCM actions.'],
	['git.revertSelectedRanges', 'Discard is available only through confirmed SCM actions.'],
	['git.runGitMerge', 'Conflict resolution belongs in an external editor.'],
	['git.runGitMergeDiff3', 'Conflict resolution belongs in an external editor.'],
	['git.timeline.compareWithSelected', 'The Timeline view is not part of the focused shell.'],
	['git.timeline.copyCommitId', 'The Timeline view is not part of the focused shell.'],
	['git.timeline.copyCommitMessage', 'The Timeline view is not part of the focused shell.'],
	['git.timeline.openDiff', 'The Timeline view is not part of the focused shell.'],
	['git.timeline.selectForCompare', 'The Timeline view is not part of the focused shell.'],
	['git.timeline.viewCommit', 'The Timeline view is not part of the focused shell.'],
]);

export const internalCommands = new Set([
	'git.api.getRemoteSources',
	'git.api.getRepositories',
	'git.api.getRepositoryState',
	'git.checkoutDetached',
	'git.closeAllUnmodifiedEditors',
	'git.openAllChanges',
	'git.openFile2',
	'git.stageChange',
	'git.stageFile',
	'git.unstageChange',
	'git.unstageFile',
]);

export const downstreamOnlyCommands = new Set([
	'git.openFileInExternalEditor',
]);

function hashLines(lines) {
	return createHash('sha256').update(lines.join('\n')).digest('hex');
}

function menuKey(entry) {
	return JSON.stringify(entry);
}

export function createGitManifestInventory(manifest) {
	const commandIds = (manifest.contributes?.commands ?? [])
		.filter(command => command.command?.startsWith('git.'))
		.map(command => command.command)
		.sort();
	const menuEntries = Object.entries(manifest.contributes?.menus ?? {})
		.flatMap(([location, items]) => items
			.filter(item => item.command?.startsWith('git.') || item.alt?.startsWith('git.'))
			.map(item => ({
				location,
				command: item.command,
				alt: item.alt ?? null,
				group: item.group ?? null,
				when: item.when ?? null,
			})))
		.sort((left, right) => menuKey(left).localeCompare(menuKey(right)));

	return {
		commandIds,
		commandCount: commandIds.length,
		commandHash: hashLines(commandIds),
		menuEntries,
		menuCount: menuEntries.length,
		menuHash: hashLines(menuEntries.map(menuKey)),
	};
}

export function classifyGitCommand(command) {
	if (excludedCommands.has(command)) {
		return 'excluded';
	}
	if (internalCommands.has(command)) {
		return 'internal';
	}
	return 'supported';
}

export function diffGitManifestInventories(baseline, candidate) {
	const baselineCommands = new Set(baseline.commandIds);
	const candidateCommands = new Set(candidate.commandIds);
	const baselineMenus = new Set(baseline.menuEntries.map(menuKey));
	const candidateMenus = new Set(candidate.menuEntries.map(menuKey));

	return {
		addedCommands: candidate.commandIds.filter(command => !baselineCommands.has(command)),
		removedCommands: baseline.commandIds.filter(command => !candidateCommands.has(command)),
		addedMenus: candidate.menuEntries.filter(entry => !baselineMenus.has(menuKey(entry))),
		removedMenus: baseline.menuEntries.filter(entry => !candidateMenus.has(menuKey(entry))),
	};
}
