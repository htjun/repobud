/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Repository Context Workbench contributors.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const repositoryRoot = process.cwd();
const applicationPath = process.env.REPOSITORY_CONTEXT_APP_PATH ??
	join(repositoryRoot, '..', 'VSCode-darwin-arm64', 'Repository Context Workbench.app');
const executablePath = join(applicationPath, 'Contents', 'MacOS', 'Repository Context');

function runGit(cwd, args) {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
	}
	return result.stdout.trim();
}

async function writeSkillFixture(root, id, name, description) {
	const directory = join(root, id);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, 'SKILL.md'), [
		'---',
		`name: ${id}`,
		`description: ${description}`,
		'---',
		'',
		`# ${name}`,
		'',
	].join('\n'));
}

async function waitFor(predicate, message) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (await predicate()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error(message);
}

async function reservePort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address === 'object');
	const port = address.port;
	await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	return port;
}

async function waitForCdp(port, child) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`Application exited before CDP was ready with code ${child.exitCode}.`);
		}

		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/version`);
			if (response.ok) {
				return;
			}
		} catch {
			// The endpoint is not ready yet.
		}

		await new Promise(resolve => setTimeout(resolve, 100));
	}

	throw new Error('Timed out waiting for the packaged application CDP endpoint.');
}

async function stopApplication(child) {
	if (child.exitCode !== null) {
		return;
	}

	child.kill('SIGTERM');
	await Promise.race([
		new Promise(resolve => child.once('exit', resolve)),
		new Promise(resolve => setTimeout(resolve, 5_000)),
	]);

	if (child.exitCode === null) {
		child.kill('SIGKILL');
	}
}

async function main() {
	assert.ok(existsSync(executablePath), `Packaged application not found at ${executablePath}`);

	const temporaryBase = process.env.REPOSITORY_CONTEXT_SMOKE_TMPDIR ?? '/tmp';
	const temporaryRoot = await mkdtemp(join(temporaryBase, 'repository-context-smoke-'));
	const fixturePath = join(temporaryRoot, 'fixture');
	const userDataPath = join(temporaryRoot, 'profile');
	const extensionsPath = join(temporaryRoot, 'extensions');
	const sharedDataPath = join(temporaryRoot, 'shared');
	const initializedConfigurationPath = join(temporaryRoot, 'configuration-new');
	const existingConfigurationPath = join(temporaryRoot, 'configuration-existing');
	const applicationLog = [];
	let browser;
	let child;
	let page;

	try {
		await Promise.all([
			mkdir(fixturePath),
			mkdir(userDataPath),
			mkdir(extensionsPath),
			mkdir(sharedDataPath),
			mkdir(initializedConfigurationPath),
			mkdir(existingConfigurationPath),
		]);
		await mkdir(join(userDataPath, 'User'));
		await Promise.all([
			writeFile(
				join(userDataPath, 'User', 'settings.json'),
				JSON.stringify({
					'files.readonlyExclude': { '**': true },
					'files.readonlyInclude': {},
					'git.allowForcePush': true,
					'git.confirmForcePush': false,
					'scm.graph.pageOnScroll': false,
					'scm.graph.pageSize': 3,
					'window.dialogStyle': 'custom',
				})
			),
			writeFile(
				join(userDataPath, 'User', 'keybindings.json'),
				JSON.stringify([{
					key: 'cmd+alt+h',
					command: 'git.diff.stageHunk',
					when: 'editorTextFocus && resourceScheme == file',
				}, {
					key: 'cmd+alt+a',
					command: 'git.commitAmend',
				}, {
					key: 'cmd+alt+d',
					command: 'git.deleteBranch',
				}, {
					key: 'cmd+alt+f',
					command: 'git.pushForce',
				}, {
					key: 'cmd+alt+g',
					command: 'git.refresh',
				}, {
					key: 'cmd+alt+r',
					command: 'git.rebase',
				}, {
					key: 'cmd+alt+w',
					command: 'git.deleteWorktree',
				}, {
					key: 'cmd+alt+c',
					command: 'repositoryContext.manageConfigurationRepository',
					args: {
						action: 'initialize',
						uri: pathToFileURL(initializedConfigurationPath).toString(),
					},
				}, {
					key: 'cmd+alt+e',
					command: 'repositoryContext.manageConfigurationRepository',
					args: {
						action: 'select',
						uri: pathToFileURL(existingConfigurationPath).toString(),
					},
				}])
			),
		]);
		runGit(existingConfigurationPath, ['init', '-b', 'main']);
		runGit(fixturePath, ['init', '-b', 'main']);
		runGit(fixturePath, ['config', 'user.name', 'Repository Context Smoke']);
		runGit(fixturePath, ['config', 'user.email', 'smoke@example.invalid']);
		await mkdir(join(fixturePath, '.repository-context'), { recursive: true });
		await Promise.all([
			writeSkillFixture(join(existingConfigurationPath, 'skills'), 'review', 'Review', 'Review repository changes.'),
			writeSkillFixture(join(existingConfigurationPath, 'skills'), 'conflict', 'Global Conflict', 'Global conflicting definition.'),
			writeSkillFixture(join(fixturePath, '.repository-context', 'skills'), 'release', 'Release', 'Prepare repository releases.'),
			writeSkillFixture(join(fixturePath, '.repository-context', 'skills'), 'conflict', 'Repository Conflict', 'Repository conflicting definition.'),
			writeFile(join(fixturePath, '.repository-context', 'config.json'), [
				'{',
				'\t"version": 1,',
				'\t"scope": "repository",',
				'\t"skills": {',
				'\t\t"release": {',
				'\t\t\t"activation": "off"',
				'\t\t}',
				'\t},',
				'\t"integrations": {}',
				'}',
				'',
			].join('\n')),
			writeFile(join(fixturePath, 'conflict.txt'), 'base\n'),
			writeFile(join(fixturePath, 'deleted.txt'), 'base\n'),
			writeFile(join(fixturePath, 'hunk.txt'), 'base\n'),
			writeFile(join(fixturePath, 'rename-old.txt'), 'base\n'),
			writeFile(join(fixturePath, 'selection.txt'), 'base\n'),
			writeFile(join(fixturePath, 'staged.txt'), 'base\n'),
			writeFile(join(fixturePath, 'unstaged.txt'), 'base\n'),
		]);
		runGit(fixturePath, ['add', '.']);
		runGit(fixturePath, ['commit', '-m', 'Initial fixture']);
		await Promise.all([
			appendFile(join(fixturePath, 'staged.txt'), 'staged\n'),
			appendFile(join(fixturePath, 'unstaged.txt'), 'unstaged\n'),
			appendFile(join(fixturePath, 'hunk.txt'), 'hunk change\n'),
			appendFile(join(fixturePath, 'selection.txt'), 'selection change\n'),
			writeFile(join(fixturePath, 'untracked.txt'), 'untracked\n'),
			unlink(join(fixturePath, 'deleted.txt')),
		]);
		runGit(fixturePath, ['add', 'staged.txt']);
		runGit(fixturePath, ['mv', 'rename-old.txt', 'rename-new.txt']);

		const cdpPort = await reservePort();
		child = spawn(executablePath, [
			`--user-data-dir=${userDataPath}`,
			`--extensions-dir=${extensionsPath}`,
			`--shared-data-dir=${sharedDataPath}`,
			`--remote-debugging-port=${cdpPort}`,
			'--disable-workspace-trust',
			'--use-mock-keychain',
			`--folder-uri=${pathToFileURL(fixturePath).toString()}`,
		], {
			env: { ...process.env, TMPDIR: temporaryRoot },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		child.stdout.on('data', chunk => applicationLog.push(chunk.toString()));
		child.stderr.on('data', chunk => applicationLog.push(chunk.toString()));

		await waitForCdp(cdpPort, child);
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
		await waitFor(() => {
			page = browser.contexts().flatMap(context => context.pages())
				.find(candidate => candidate.url().includes('/workbench/workbench'));
			return Boolean(page);
		}, 'Workbench page was not exposed through CDP.');

		const consoleErrors = [];
		page.on('console', message => {
			if (message.type() === 'error') {
				consoleErrors.push(message.text());
			}
		});
		page.on('pageerror', error => consoleErrors.push(error.message));

		await page.getByRole('tablist', { name: 'Active View Switcher' }).waitFor();
		await page.getByRole('treeitem', { name: /^staged\.txt, Index Modified/ }).waitFor();
		await page.getByRole('treeitem', { name: /^unstaged\.txt, Modified/ }).waitFor();
		await page.getByRole('treeitem', { name: /^untracked\.txt, Untracked/ }).waitFor();
		await page.getByRole('treeitem', { name: /^rename-new\.txt, Index Renamed/ }).waitFor();
		await page.getByRole('treeitem', { name: /^deleted\.txt, Deleted/ }).waitFor();
		await page.getByRole('treeitem', { name: /^hunk\.txt, Modified/ }).waitFor();
		await page.getByRole('treeitem', { name: /^selection\.txt, Modified/ }).waitFor();
		await page.getByRole('treeitem', { name: /Initial fixture/ }).waitFor();

		assert.equal(await page.getByRole('tab').count(), 3);
		assert.equal(await page.getByRole('tab', { name: /^Source Control/ }).count(), 1);
		assert.equal(await page.getByRole('tab', { name: 'Skills' }).count(), 1);
		assert.equal(await page.getByRole('tab', { name: 'Integrations' }).count(), 1);
		assert.equal(await page.getByRole('button', { name: 'Generate Commit Message' }).count(), 0);
		assert.equal(await page.getByRole('button', { name: /^(Agents|Chat|Accounts|Manage)$/ }).count(), 0);

		await page.keyboard.press('Meta+Alt+C');
		const initializedConfigurationFile = join(initializedConfigurationPath, 'repository-context.json');
		await waitFor(
			() => existsSync(join(initializedConfigurationPath, '.git')) && existsSync(initializedConfigurationFile),
			'Configuration repository was not initialized.'
		);
		const expectedGlobalConfiguration = [
			'{',
			'\t"version": 1,',
			'\t"scope": "global",',
			'\t"skills": {},',
			'\t"integrations": {}',
			'}',
			'',
		].join('\n');
		assert.equal(await readFile(initializedConfigurationFile, 'utf8'), expectedGlobalConfiguration);
		assert.equal(runGit(initializedConfigurationPath, ['status', '--porcelain']), '?? repository-context.json');
		assert.notEqual(
			spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: initializedConfigurationPath }).status,
			0,
			'Configuration initialization unexpectedly created a commit.'
		);
		assert.equal(runGit(initializedConfigurationPath, ['remote']), '');
		assert.deepEqual(
			(await readdir(initializedConfigurationPath)).filter(name => name.includes('repository-context-tmp')),
			[],
			'Atomic write temporary files were left behind.'
		);

		await page.keyboard.press('Meta+Alt+E');
		const existingConfigurationFile = join(existingConfigurationPath, 'repository-context.json');
		await waitFor(
			() => existsSync(existingConfigurationFile),
			'Existing configuration repository was not adopted.'
		);
		assert.equal(await readFile(existingConfigurationFile, 'utf8'), expectedGlobalConfiguration);
		assert.deepEqual(
			runGit(existingConfigurationPath, ['status', '--porcelain']).split('\n').sort(),
			['?? repository-context.json', '?? skills/']
		);
		assert.notEqual(
			spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: existingConfigurationPath }).status,
			0,
			'Selecting a configuration repository unexpectedly created a commit.'
		);
		assert.equal(runGit(existingConfigurationPath, ['remote']), '');

		await page.getByRole('button', { name: 'Views and More Actions...' }).click();
		await page.getByRole('menuitem', { name: 'Manage Configuration Repository...' }).waitFor();
		await page.keyboard.press('Escape');

		await page.getByRole('tab', { name: 'Skills' }).click();
		await page.getByText('Active repository').waitFor();
		await page.locator('.repository-context-skills-context-name').getByText('fixture', { exact: true }).waitFor();
		await page.getByRole('heading', { name: 'Enabled 1' }).waitFor();
		await page.getByRole('heading', { name: 'Available 1' }).waitFor();
		await page.getByRole('heading', { name: 'Needs attention 1' }).waitFor();

		const reviewSkill = page.locator('.repository-context-skill-row[data-skill-id="review"]');
		const releaseSkill = page.locator('.repository-context-skill-row[data-skill-id="release"]');
		const conflictSkill = page.locator('.repository-context-skill-row[data-skill-id="conflict"]');
		assert.match(await reviewSkill.innerText(), /Global/i);
		assert.match(await reviewSkill.innerText(), /Enabled by default/);
		assert.match(await releaseSkill.innerText(), /Repository/i);
		assert.match(await releaseSkill.innerText(), /Disabled by repository override/);
		assert.match(await conflictSkill.innerText(), /Repository/i);
		assert.match(await conflictSkill.innerText(), /Global/i);
		assert.match(await conflictSkill.innerText(), /Conflicting canonical definitions/);
		assert.match(await conflictSkill.innerText(), /Unavailable until the issue is resolved/);

		await releaseSkill.getByRole('button', { name: 'On' }).click();
		await waitFor(async () => {
			const configuration = JSON.parse(await readFile(
				join(fixturePath, '.repository-context', 'config.json'),
				'utf8'
			));
			return configuration.skills.release?.activation === 'on';
		}, 'Repository Skill On override was not persisted.');
		const codexProjection = releaseSkill.locator('.repository-context-skill-client-row').filter({ hasText: 'Codex' });
		const claudeProjection = releaseSkill.locator('.repository-context-skill-client-row').filter({ hasText: 'Claude Code' });
		const cursorProjection = releaseSkill.locator('.repository-context-skill-client-row').filter({ hasText: 'Cursor' });
		await codexProjection.getByRole('button', { name: 'Project' }).click();
		const releaseProjectionPath = join(fixturePath, '.agents', 'skills', 'release');
		const claudeProjectionPath = join(fixturePath, '.claude', 'skills', 'release');
		const canonicalReleasePath = join(fixturePath, '.repository-context', 'skills', 'release');
		await waitFor(
			async () => existsSync(releaseProjectionPath) && (await lstat(releaseProjectionPath)).isSymbolicLink(),
			'Repository Skill was not projected to Codex as a directory symlink.'
		);
		assert.equal(await realpath(releaseProjectionPath), await realpath(canonicalReleasePath));
		await codexProjection.getByText('Codex · Compatible · Linked', { exact: true }).waitFor();
		await cursorProjection.getByText('Cursor · Compatible · Linked', { exact: true }).waitFor();
		await claudeProjection.getByRole('button', { name: 'Project' }).click();
		await waitFor(
			async () => existsSync(claudeProjectionPath) && (await lstat(claudeProjectionPath)).isSymbolicLink(),
			'Repository Skill was not projected to Claude Code as a directory symlink.'
		);
		assert.equal(await realpath(claudeProjectionPath), await realpath(canonicalReleasePath));
		await claudeProjection.getByText('Claude Code · Compatible · Linked', { exact: true }).waitFor();

		await unlink(releaseProjectionPath);
		await writeSkillFixture(
			join(fixturePath, '.agents', 'skills'),
			'release',
			'Release',
			'Imported external release workflow.'
		);
		await page.getByRole('button', { name: 'Refresh Skills' }).click();
		await codexProjection.getByText('Codex · Compatible · Modified', { exact: true }).waitFor();
		await cursorProjection.getByText('Cursor · Compatible · Modified', { exact: true }).waitFor();
		await codexProjection.getByRole('button', { name: 'Import changes' }).click();
		const importDialog = page.getByRole('dialog').filter({
			hasText: 'Import projected changes into the canonical Skill?',
		});
		await importDialog.waitFor();
		await importDialog.getByRole('button', { name: 'Import changes' }).click();
		await waitFor(
			async () => (await readFile(join(canonicalReleasePath, 'SKILL.md'), 'utf8'))
				.includes('Imported external release workflow.'),
			'Explicit projection import did not update the canonical Skill.'
		);
		assert.equal((await lstat(releaseProjectionPath)).isSymbolicLink(), true);

		await unlink(releaseProjectionPath);
		await writeSkillFixture(
			join(fixturePath, '.agents', 'skills'),
			'release',
			'Release',
			'Discarded external release workflow.'
		);
		await page.getByRole('button', { name: 'Refresh Skills' }).click();
		await codexProjection.getByText('Codex · Compatible · Modified', { exact: true }).waitFor();
		await codexProjection.getByRole('button', { name: 'Restore projection' }).click();
		const restoreDialog = page.getByRole('dialog').filter({
			hasText: 'Restore the Codex projection from canonical content?',
		});
		await restoreDialog.waitFor();
		await restoreDialog.getByRole('button', { name: 'Restore projection' }).click();
		await waitFor(
			async () => existsSync(releaseProjectionPath) && (await lstat(releaseProjectionPath)).isSymbolicLink(),
			'Explicit projection restore did not recreate the canonical directory symlink.'
		);
		assert.equal(await realpath(releaseProjectionPath), await realpath(canonicalReleasePath));
		assert.match(
			await readFile(join(canonicalReleasePath, 'SKILL.md'), 'utf8'),
			/Imported external release workflow/
		);

		await reviewSkill.getByRole('button', { name: 'Off' }).click();
		await waitFor(async () => {
			const configuration = JSON.parse(await readFile(
				join(fixturePath, '.repository-context', 'config.json'),
				'utf8'
			));
			return configuration.skills.review?.activation === 'off';
		}, 'Repository Skill Off override was not persisted.');
		await reviewSkill.getByRole('button', { name: 'Inherit' }).click();
		await waitFor(async () => {
			const configuration = JSON.parse(await readFile(
				join(fixturePath, '.repository-context', 'config.json'),
				'utf8'
			));
			return configuration.skills.review === undefined;
		}, 'Repository Skill override was not removed.');
		assert.doesNotMatch(
			await readFile(join(fixturePath, '.repository-context', 'config.json'), 'utf8'),
			new RegExp(temporaryRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
		);

		await page.getByRole('button', { name: 'Views and More Actions...' }).click();
		await page.getByRole('menuitem', { name: 'Manage Global Skill Library...' }).waitFor();
		await page.keyboard.press('Escape');
		await page.getByRole('tab', { name: /^Source Control/ }).click();
		await page.getByRole('treeitem', { name: /^staged\.txt, Index Modified/ }).waitFor();

		await page.getByRole('treeitem', { name: /^staged\.txt, Index Modified/ }).click();
		await page.locator('.monaco-diff-editor').waitFor();
		assert.match(await page.getByRole('main').innerText(), /staged\.txt \(Index\)/);
		await page.getByRole('treeitem', { name: /^unstaged\.txt, Modified/ }).click();
		await page.locator('.monaco-diff-editor').waitFor();
		assert.match(await page.getByRole('main').innerText(), /unstaged\.txt \(Working Tree\)/);
		const diffEditorAutocompleteModes = await page.locator('.monaco-diff-editor .native-edit-context')
			.evaluateAll(editors => editors.map(editor => editor.getAttribute('aria-autocomplete')));
		assert.ok(diffEditorAutocompleteModes.length >= 2, 'Expected both sides of the diff editor.');
		assert.ok(
			diffEditorAutocompleteModes.every(mode => mode === 'none'),
			`Diff editor was not read-only: ${diffEditorAutocompleteModes.join(', ')}`
		);
		await page.keyboard.press('Meta+W');

		const hunkItem = page.getByRole('treeitem', { name: /^hunk\.txt, Modified/ });
		await hunkItem.click();
		await page.locator('.modified-in-monaco-diff-editor .view-line').filter({ hasText: 'hunk change' }).click();
		await page.keyboard.press('Meta+Alt+H');
		const stagedHunkItem = page.getByRole('treeitem', { name: /^hunk\.txt, Index Modified/ });
		await stagedHunkItem.waitFor();
		await stagedHunkItem.click();
		await page.locator('.modified-in-monaco-diff-editor .view-line').filter({ hasText: 'hunk change' }).click();
		await page.keyboard.press('Meta+K');
		await page.keyboard.press('Meta+N');
		await hunkItem.waitFor();
		await page.keyboard.press('Meta+W');

		const selectionItem = page.getByRole('treeitem', { name: /^selection\.txt, Modified/ });
		await selectionItem.click();
		await page.locator('.modified-in-monaco-diff-editor .view-line').filter({ hasText: 'selection change' }).click();
		await page.keyboard.press('Meta+K');
		await page.keyboard.press('Meta+Alt+S');
		const stagedSelectionItem = page.getByRole('treeitem', { name: /^selection\.txt, Index Modified/ });
		await stagedSelectionItem.waitFor();
		await stagedSelectionItem.click();
		await page.locator('.modified-in-monaco-diff-editor .view-line').filter({ hasText: 'selection change' }).click();
		await page.keyboard.press('Meta+K');
		await page.keyboard.press('Meta+N');
		await selectionItem.waitFor();
		await page.keyboard.press('Meta+W');

		let untrackedItem = page.getByRole('treeitem', { name: /^untracked\.txt, Untracked/ });
		await untrackedItem.hover();
		await untrackedItem.getByRole('button', { name: 'Stage Changes' }).click();
		const stagedUntrackedItem = page.getByRole('treeitem', { name: /^untracked\.txt, Index Added/ });
		await stagedUntrackedItem.waitFor();
		await stagedUntrackedItem.hover();
		await stagedUntrackedItem.getByRole('button', { name: 'Unstage Changes' }).click();
		untrackedItem = page.getByRole('treeitem', { name: /^untracked\.txt, Untracked/ });
		await untrackedItem.waitFor();

		const unstagedItem = page.getByRole('treeitem', { name: /^unstaged\.txt, Modified/ });
		await unstagedItem.hover();
		await unstagedItem.getByRole('button', { name: 'Discard Changes' }).click();
		const discardDialog = page.getByRole('dialog').filter({ hasText: 'discard changes' });
		await discardDialog.waitFor();
		await discardDialog.getByRole('button', { name: 'Discard File' }).click();
		await unstagedItem.waitFor({ state: 'detached' });
		assert.equal(await readFile(join(fixturePath, 'unstaged.txt'), 'utf8'), 'base\n');

		runGit(fixturePath, ['reset', '--hard', 'HEAD']);
		runGit(fixturePath, ['clean', '-fd']);
		await writeFile(join(fixturePath, 'commit-target.txt'), 'commit target\n');
		runGit(fixturePath, ['add', 'commit-target.txt']);
		const hookPath = join(fixturePath, '.git', 'hooks', 'pre-commit');
		await writeFile(hookPath, '#!/bin/sh\necho "hook blocked commit" >&2\nexit 1\n');
		await chmod(hookPath, 0o755);
		await page.getByRole('treeitem', { name: /^commit-target\.txt, Index Added/ }).waitFor();

		const commitInput = page.getByRole('treeitem', { name: 'Source Control Input' }).getByRole('textbox');
		await commitInput.focus();
		await page.keyboard.type('Smoke commit');
		const commitButton = page.getByRole('button', { name: 'Commit Changes on "main"' });
		await commitButton.click();
		const hookFailureDialog = page.getByRole('dialog').filter({ hasText: 'hook blocked commit' });
		await hookFailureDialog.waitFor();
		assert.match(await hookFailureDialog.innerText(), /Git: hook blocked commit/);
		assert.equal(runGit(fixturePath, ['log', '-1', '--pretty=%s']), 'Initial fixture');
		await page.keyboard.press('Escape');

		await unlink(hookPath);
		await commitButton.click();
		await waitFor(
			() => runGit(fixturePath, ['log', '-1', '--pretty=%s']) === 'Smoke commit',
			'Commit did not complete after the failing hook was removed.'
		);
		await page.getByRole('treeitem', { name: /^commit-target\.txt,/ }).waitFor({ state: 'detached' });

		await writeFile(join(fixturePath, 'amend-target.txt'), 'amend target\n');
		runGit(fixturePath, ['add', 'amend-target.txt']);
		await page.getByRole('treeitem', { name: /^amend-target\.txt, Index Added/ }).waitFor();
		await commitInput.focus();
		await page.keyboard.type('Amended smoke');
		await page.keyboard.press('Meta+Alt+A');
		const amendDialog = page.getByRole('dialog').filter({ hasText: 'Amend the current commit?' });
		await amendDialog.waitFor();
		assert.match(await amendDialog.innerText(), /Amend the current commit\?/);
		assert.match(await amendDialog.innerText(), /Current commit: .* Smoke commit/);
		assert.match(await amendDialog.innerText(), /Staged files: 1/);
		await page.keyboard.press('Escape');
		assert.equal(runGit(fixturePath, ['log', '-1', '--pretty=%s']), 'Smoke commit');
		runGit(fixturePath, ['reset', '--hard', 'HEAD']);
		runGit(fixturePath, ['clean', '-fd']);

		runGit(fixturePath, ['branch', 'delete-me']);
		await page.keyboard.press('Meta+Alt+D');
		await page.getByRole('option', { name: /delete-me/ }).click();
		const branchDeleteDialog = page.getByRole('dialog').filter({ hasText: 'Delete branch "delete-me"?' });
		await branchDeleteDialog.waitFor();
		assert.match(await branchDeleteDialog.innerText(), /Delete branch "delete-me"\?/);
		assert.match(await branchDeleteDialog.innerText(), /Location: Local/);
		assert.match(await branchDeleteDialog.innerText(), /Tip: /);
		await page.keyboard.press('Escape');
		assert.match(runGit(fixturePath, ['branch', '--list', 'delete-me']), /delete-me/);

		runGit(fixturePath, ['branch', 'rebase-target']);
		await writeFile(join(fixturePath, 'rebase.txt'), 'rebase\n');
		runGit(fixturePath, ['add', 'rebase.txt']);
		runGit(fixturePath, ['commit', '-m', 'Rebase source']);
		await page.keyboard.press('Meta+Alt+R');
		await page.getByRole('option', { name: /rebase-target/ }).click();
		const rebaseDialog = page.getByRole('dialog').filter({ hasText: 'Rebase the current branch?' });
		await rebaseDialog.waitFor();
		assert.match(await rebaseDialog.innerText(), /Rebase the current branch\?/);
		assert.match(await rebaseDialog.innerText(), /Commits to replay: 1/);
		await page.keyboard.press('Escape');

		const worktreePath = join(temporaryRoot, 'review-worktree');
		runGit(fixturePath, ['worktree', 'add', '-b', 'worktree-review', worktreePath, 'main']);
		await page.keyboard.press('Meta+Alt+W');
		await page.getByRole('option', { name: /worktree-review/ }).click();
		const worktreeDeleteDialog = page.getByRole('dialog').filter({ hasText: 'Delete worktree' });
		await worktreeDeleteDialog.waitFor();
		assert.match(await worktreeDeleteDialog.innerText(), /Delete worktree/);
		assert.match(await worktreeDeleteDialog.innerText(), /Branch: worktree-review/);
		assert.match(await worktreeDeleteDialog.innerText(), new RegExp(worktreePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
		await page.keyboard.press('Escape');
		assert.ok(existsSync(worktreePath));

		const remotePath = join(temporaryRoot, 'remote.git');
		runGit(temporaryRoot, ['init', '--bare', remotePath]);
		runGit(fixturePath, ['remote', 'add', 'origin', remotePath]);
		runGit(fixturePath, ['push', '-u', 'origin', 'main']);
		await page.keyboard.press('Meta+Alt+G');
		await waitFor(
			() => page.getByRole('button', { name: 'Pull' }).isEnabled(),
			'Remote state did not refresh after adding origin.'
		);
		await page.keyboard.press('Meta+Alt+F');
		const forcePushDialog = page.getByRole('dialog').filter({ hasText: 'Force push this branch?' });
		await forcePushDialog.waitFor();
		assert.match(await forcePushDialog.innerText(), /Force push this branch\?/);
		assert.match(await forcePushDialog.innerText(), /Remote: origin/);
		await page.keyboard.press('Escape');

		runGit(fixturePath, ['switch', '-c', 'graph-feature']);
		await writeFile(join(fixturePath, 'graph-feature.txt'), 'feature\n');
		runGit(fixturePath, ['add', 'graph-feature.txt']);
		runGit(fixturePath, ['commit', '-m', 'Graph feature']);
		runGit(fixturePath, ['switch', 'main']);
		await writeFile(join(fixturePath, 'graph-main.txt'), 'main\n');
		runGit(fixturePath, ['add', 'graph-main.txt']);
		runGit(fixturePath, ['commit', '-m', 'Graph main']);
		runGit(fixturePath, ['merge', '--no-ff', 'graph-feature', '-m', 'Graph merge']);
		runGit(fixturePath, ['tag', 'v-smoke']);
		runGit(fixturePath, ['push', 'origin', 'main', '--tags']);
		await page.getByRole('treeitem', { name: /Graph merge/ }).waitFor();
		const graphMergeItem = page.getByRole('treeitem', { name: /Graph merge/ });
		assert.match(await graphMergeItem.innerText(), /main/);
		await graphMergeItem.hover();
		const graphMergeHover = page.locator('.monaco-hover-content').filter({ hasText: 'origin/main' }).last();
		await graphMergeHover.waitFor();
		assert.match(await graphMergeHover.innerText(), /origin\/main/);
		assert.match(await graphMergeHover.innerText(), /v-smoke/);

		await writeFile(join(fixturePath, 'refresh.txt'), 'refresh\n');
		runGit(fixturePath, ['add', 'refresh.txt']);
		runGit(fixturePath, ['commit', '-m', 'Stale refresh']);
		await page.getByRole('button', { name: 'Refresh' }).last().click();
		await page.getByRole('treeitem', { name: /Stale refresh/ }).waitFor();
		const historyTree = page.getByRole('tree', { name: 'Source Control History' });
		const historyItemsBeforePagination = await historyTree.getByRole('treeitem').count();
		let loadMoreItem = page.getByRole('treeitem', { name: /Load More/ });
		await loadMoreItem.waitFor();
		await loadMoreItem.click();
		await waitFor(
			async () => await historyTree.getByRole('treeitem').count() > historyItemsBeforePagination,
			'Graph pagination did not append history items.'
		);
		loadMoreItem = page.getByRole('treeitem', { name: /Load More/ });
		await loadMoreItem.click();
		await page.getByRole('treeitem', { name: /Initial fixture/ }).waitFor();

		runGit(fixturePath, ['switch', '-c', 'incoming']);
		await writeFile(join(fixturePath, 'conflict.txt'), 'incoming\n');
		runGit(fixturePath, ['add', 'conflict.txt']);
		runGit(fixturePath, ['commit', '-m', 'Incoming conflict']);
		runGit(fixturePath, ['switch', 'main']);
		await writeFile(join(fixturePath, 'conflict.txt'), 'main\n');
		runGit(fixturePath, ['add', 'conflict.txt']);
		runGit(fixturePath, ['commit', '-m', 'Main conflict']);
		const mergeResult = spawnSync('git', ['merge', 'incoming'], { cwd: fixturePath, encoding: 'utf8' });
		assert.notEqual(mergeResult.status, 0, 'Conflict fixture unexpectedly merged cleanly.');
		const conflictItem = page.getByRole('treeitem', { name: /^conflict\.txt, Conflict: Both Modified/ });
		await conflictItem.waitFor();
		await conflictItem.click({ button: 'right' });
		await page.getByRole('menuitem', { name: 'Open in External Editor' }).waitFor();
		await page.keyboard.press('Escape');

		await page.getByRole('button', { name: 'Switch Repository' }).click();
		await page.getByRole('option', { name: /check fixture,/ }).waitFor();
		await page.getByRole('option', { name: /configuration-new,/ }).waitFor();
		await page.getByRole('option', { name: /configuration-existing,/ }).waitFor();
		assert.equal(await page.getByRole('option', { name: /Open Existing Repository/ }).count(), 1);
		assert.equal(await page.getByRole('option', { name: /Clone Repository/ }).count(), 1);
		assert.equal(await page.getByRole('option', { name: /Initialize Repository/ }).count(), 1);
		await page.keyboard.press('Escape');

		await page.keyboard.press('Meta+N');
		await page.keyboard.press('Meta+Shift+P');
		await page.keyboard.press('Control+Backquote');
		await page.keyboard.press('F5');
		const shellState = await page.evaluate(() => {
			const isVisible = element => {
				if (!(element instanceof HTMLElement)) {
					return false;
				}
				const style = getComputedStyle(element);
				return style.display !== 'none' && style.visibility !== 'hidden' && element.getBoundingClientRect().height > 0;
			};
			return {
				title: document.title,
				editorIsEmpty: Boolean(document.querySelector('.editor-group-container.empty')),
				quickInputIsVisible: isVisible(document.querySelector('.quick-input-widget')),
				terminalIsVisible: Array.from(document.querySelectorAll('.terminal-wrapper')).some(isVisible),
				panelIsVisible: isVisible(document.querySelector('.part.panel')),
			};
		});
		assert.equal(shellState.editorIsEmpty, true, JSON.stringify(shellState));
		assert.equal(shellState.quickInputIsVisible, false, JSON.stringify(shellState));
		assert.equal(shellState.terminalIsVisible, false, JSON.stringify(shellState));
		assert.equal(shellState.panelIsVisible, false, JSON.stringify(shellState));
		assert.match(shellState.title, /fixture/);
		assert.doesNotMatch(shellState.title, /Untitled/);
		assert.equal(await page.locator('.monaco-dialog-box').count(), 0);
		assert.equal(consoleErrors.length, 0, consoleErrors.join('\n'));
		assert.doesNotMatch(applicationLog.join(''), /AgentHostProcessManager: agent host started/);

		console.log('Repository Context packaged shell smoke test passed.');
	} catch (error) {
		if (page) {
			console.error(await page.locator('body').ariaSnapshot().catch(() => 'Unable to capture accessibility snapshot.'));
		}
		if (applicationLog.length > 0) {
			console.error(applicationLog.join(''));
		}
		throw error;
	} finally {
		await browser?.close().catch(() => undefined);
		if (child) {
			await stopApplication(child);
		}
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}

await main();
