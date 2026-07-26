/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import {
	classifyGitCommand,
	createGitManifestInventory,
	diffGitManifestInventories,
	downstreamOnlyCommands,
	pinnedUpstreamInventory,
} from './git-command-inventory.mts';

const repositoryRoot = resolve(import.meta.dirname, '..');
const expectedUpstreamUrl = 'https://github.com/microsoft/vscode.git';

/**
 * Reads a required-value command-line option.
 */
function readOption(name) {
	const index = process.argv.indexOf(name);
	if (index === -1) {
		return undefined;
	}
	const value = process.argv[index + 1];
	if (!value || value.startsWith('--')) {
		throw new Error(`${name} requires a value.`);
	}
	return value;
}

/**
 * Runs Git in the downstream source checkout and returns trimmed stdout.
 */
function runGit(args) {
	return execFileSync('git', args, {
		cwd: repositoryRoot,
		encoding: 'utf8',
		maxBuffer: 50 * 1024 * 1024,
	}).trim();
}

/**
 * Reads the Git extension manifest at a specific revision.
 */
function readManifest(revision) {
	return JSON.parse(runGit(['show', `${revision}:extensions/git/package.json`]));
}

/**
 * Formats a report section as a Markdown list.
 */
function formatList(values, formatter = value => `- \`${value}\``) {
	return values.length === 0 ? '- None' : values.map(formatter).join('\n');
}

/**
 * Formats a normalized menu entry for the rehearsal report.
 */
function formatMenu(entry) {
	const suffix = [
		entry.alt && `alt=${entry.alt}`,
		entry.group && `group=${entry.group}`,
		entry.when && `when=${entry.when}`,
	].filter(Boolean).join(', ');
	return `- \`${entry.location}: ${entry.command}\`${suffix ? ` (${suffix})` : ''}`;
}

/**
 * Resolves a tag directly from the official upstream remote.
 */
function readRemoteTagCommit(tag) {
	const result = spawnSync(
		'git',
		[
			'ls-remote',
			'--exit-code',
			'--tags',
			'upstream',
			`refs/tags/${tag}`,
			`refs/tags/${tag}^{}`,
		],
		{
			cwd: repositoryRoot,
			encoding: 'utf8',
			maxBuffer: 1024 * 1024,
		}
	);
	assert.equal(
		result.status,
		0,
		`The candidate tag ${tag} does not exist on the official upstream remote: ${result.stderr.trim()}`
	);
	const references = new Map(
		result.stdout.trim().split('\n').filter(Boolean).map(line => {
			const [commit, reference] = line.split(/\s+/);
			return [reference, commit];
		})
	);
	const commit = references.get(`refs/tags/${tag}^{}`) ?? references.get(`refs/tags/${tag}`);
	assert.match(commit ?? '', /^[a-f0-9]{40}$/, `The upstream tag ${tag} did not resolve to a commit.`);
	return commit;
}

const candidateTag = readOption('--tag') ?? pinnedUpstreamInventory.tag;
const reportPath = readOption('--report');
const shouldFetch = process.argv.includes('--fetch');
const allowDeclarationDelta = process.argv.includes('--allow-declaration-delta');

assert.match(candidateTag, /^\d+\.\d+\.\d+$/, 'The candidate must be an exact stable version tag.');
assert.equal(
	runGit(['remote', 'get-url', 'upstream']),
	expectedUpstreamUrl,
	'The upstream remote does not point to the official microsoft/vscode repository.'
);

if (shouldFetch) {
	const fetchResult = spawnSync(
		'git',
		['fetch', 'upstream', `+refs/tags/${candidateTag}:refs/tags/${candidateTag}`],
		{ cwd: repositoryRoot, encoding: 'utf8', stdio: 'inherit' }
	);
	if (fetchResult.status !== 0) {
		process.exit(fetchResult.status ?? 1);
	}
}

const candidateRevision = `refs/tags/${candidateTag}`;
const candidateObjectType = runGit(['cat-file', '-t', candidateRevision]);
assert.ok(
	candidateObjectType === 'commit' || candidateObjectType === 'tag',
	'The candidate must resolve to a stable-tag commit.'
);
const candidateCommit = runGit(['rev-parse', `${candidateRevision}^{commit}`]);
const remoteCandidateCommit = readRemoteTagCommit(candidateTag);
assert.equal(
	candidateCommit,
	remoteCandidateCommit,
	`The local candidate tag ${candidateTag} does not match the official upstream tag. Rerun with --fetch.`
);
const baselineRevision = `refs/tags/${pinnedUpstreamInventory.tag}`;
const baselineCommit = runGit(['rev-parse', `${baselineRevision}^{commit}`]);
assert.equal(
	baselineCommit,
	pinnedUpstreamInventory.commit,
	'The pinned upstream tag no longer resolves to its recorded commit.'
);

const baseline = createGitManifestInventory(readManifest(baselineRevision));
const candidate = createGitManifestInventory(readManifest(candidateRevision));
const downstream = createGitManifestInventory(
	JSON.parse(runGit(['show', 'HEAD:extensions/git/package.json']))
);
for (const field of ['commandCount', 'commandHash', 'menuCount', 'menuHash']) {
	assert.equal(
		baseline[field],
		pinnedUpstreamInventory[field],
		`The recorded upstream ${field} no longer matches ${pinnedUpstreamInventory.tag}.`
	);
}

const delta = diffGitManifestInventories(baseline, candidate);
const removedRetainedCommands = delta.removedCommands.filter(command => classifyGitCommand(command) !== 'excluded');
const downstreamCommandsMissingLocally = [...downstreamOnlyCommands]
	.filter(command => !downstream.commandIds.includes(command));
assert.deepEqual(
	downstreamCommandsMissingLocally,
	[],
	'The current downstream manifest is missing a downstream-owned retained command.'
);

const declarationDelta = [
	delta.addedCommands,
	delta.removedCommands,
	delta.addedMenus,
	delta.removedMenus,
].some(entries => entries.length > 0);
const report = [
	'# Upstream stable-tag rehearsal',
	'',
	`- Baseline: \`${pinnedUpstreamInventory.tag}\` at \`${baselineCommit}\``,
	`- Candidate: \`${candidateTag}\` at \`${candidateCommit}\``,
	`- Commands: ${baseline.commandCount} → ${candidate.commandCount}`,
	`- Menu entries: ${baseline.menuCount} → ${candidate.menuCount}`,
	`- Declaration review: ${declarationDelta ? 'required' : 'no delta'}`,
	`- Removed retained commands: ${removedRetainedCommands.length}`,
	'',
	'## Added commands',
	'',
	formatList(delta.addedCommands),
	'',
	'## Removed commands',
	'',
	formatList(delta.removedCommands),
	'',
	'## Added menu entries',
	'',
	formatList(delta.addedMenus, formatMenu),
	'',
	'## Removed menu entries',
	'',
	formatList(delta.removedMenus, formatMenu),
	'',
].join('\n');

if (reportPath) {
	await writeFile(resolve(repositoryRoot, reportPath), report);
}
console.log(report);

if (removedRetainedCommands.length > 0) {
	throw new Error('The candidate removes retained Git commands; the downstream policy must be reconciled.');
}
if (declarationDelta && !allowDeclarationDelta) {
	throw new Error(
		'The candidate changes Git command or menu declarations. Review the report, update the retained inventory, ' +
		'then rerun with --allow-declaration-delta as part of an upgrade branch.'
	);
}
