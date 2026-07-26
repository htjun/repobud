/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { promisify } from 'util';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IEnvironmentMainService } from '../../../environment/electron-main/environmentMainService.js';
import {
	IPluginPackageManifest,
	PLUGIN_INSTALL_RECORD_FILE,
	PLUGIN_MANIFEST_FILE,
} from '../../common/pluginPackage.js';
import { RepositoryContextPluginPackageMainService } from '../../electron-main/pluginPackageMainService.js';

const execFileAsync = promisify(execFile);

suite('RepositoryContextPluginPackageMainService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let fixtureRoot: string;
	let configurationRepository: string;
	let source: string;
	let service: RepositoryContextPluginPackageMainService;

	setup(async () => {
		fixtureRoot = await fs.mkdtemp(join(tmpdir(), 'repository-context-plugin-test-'));
		configurationRepository = join(fixtureRoot, 'configuration');
		source = join(fixtureRoot, 'source');
		await fs.mkdir(configurationRepository, { recursive: true });
		service = new RepositoryContextPluginPackageMainService({
			userDataPath: join(fixtureRoot, 'user-data'),
		} as IEnvironmentMainService);
	});

	teardown(async () => {
		await fs.rm(fixtureRoot, { recursive: true, force: true });
	});

	async function writePlugin(options: {
		version: string;
		readme: string;
		localFile?: string;
		script?: string;
	}): Promise<void> {
		await fs.rm(source, { recursive: true, force: true });
		await Promise.all([
			fs.mkdir(join(source, 'skills', 'review'), { recursive: true }),
			fs.mkdir(join(source, 'integrations'), { recursive: true }),
			fs.mkdir(join(source, 'scripts'), { recursive: true }),
		]);
		const manifest: IPluginPackageManifest = {
			schemaVersion: 1,
			id: 'review-tools',
			name: 'Review Tools',
			version: options.version,
			license: 'MIT',
			skills: ['skills/review'],
			integrations: ['integrations/issues.json'],
			scripts: options.script ? ['scripts/check.sh'] : [],
			connections: [{ provider: 'github' }],
		};
		await Promise.all([
			fs.writeFile(join(source, PLUGIN_MANIFEST_FILE), `${JSON.stringify(manifest, null, '\t')}\n`),
			fs.writeFile(
				join(source, 'skills', 'review', 'SKILL.md'),
				'---\nname: review\ndescription: Review changes.\n---\n\n# Review\n'
			),
			fs.writeFile(
				join(source, 'integrations', 'issues.json'),
				'{"version":1,"id":"issues","name":"Issues","description":"Issue tools.","transport":{"type":"http","url":"https://example.com/mcp"}}\n'
			),
			fs.writeFile(join(source, 'README.md'), options.readme),
			fs.writeFile(join(source, 'LOCAL.md'), options.localFile ?? 'base local\n'),
		]);
		if (options.script) {
			await fs.writeFile(join(source, 'scripts', 'check.sh'), options.script, { mode: 0o755 });
		}
	}

	test('previews authority, binds trust to content, and keeps lifecycle actions distinct', async () => {
		await writePlugin({
			version: '1.0.0',
			readme: 'version one\n',
			script: '#!/bin/sh\nexit 0\n',
		});
		const sourceRequest = { type: 'local' as const, location: URI.file(source) };
		const preview = await service.preview(sourceRequest);

		assert.strictEqual(preview.manifest.skills[0], 'skills/review');
		assert.strictEqual(preview.manifest.integrations[0], 'integrations/issues.json');
		assert.strictEqual(preview.manifest.scripts[0], 'scripts/check.sh');
		assert.strictEqual(preview.manifest.connections[0].provider, 'github');
		assert.strictEqual(preview.trustRequired, true);
		assert.match(preview.contentHash, /^[a-f0-9]{64}$/);

		const installed = await service.install(
			URI.file(configurationRepository),
			sourceRequest,
			preview.contentHash,
			false
		);
		assert.strictEqual(installed.enabled, false);
		assert.strictEqual(installed.trusted, false);
		assert.strictEqual(await fs.stat(installed.resource.fsPath).then(stat => stat.isDirectory()), true);
		assert.strictEqual(
			await fs.stat(join(installed.resource.fsPath, PLUGIN_INSTALL_RECORD_FILE))
				.then(stat => stat.isFile()),
			true
		);
		assert.doesNotMatch(
			await fs.readFile(join(installed.resource.fsPath, PLUGIN_INSTALL_RECORD_FILE), 'utf8'),
			new RegExp(fixtureRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
		);
		await assert.rejects(
			() => service.setEnabled(URI.file(configurationRepository), installed.manifest.id, true),
			/explicitly trusted/
		);

		const trusted = await service.grantTrust(
			URI.file(configurationRepository),
			installed.manifest.id
		);
		assert.strictEqual(trusted.trusted, true);
		const enabled = await service.setEnabled(
			URI.file(configurationRepository),
			installed.manifest.id,
			true
		);
		assert.strictEqual(enabled.enabled, true);

		await fs.appendFile(join(enabled.resource.fsPath, 'scripts', 'check.sh'), 'echo changed\n');
		const modified = (await service.list(URI.file(configurationRepository)))[0];
		assert.strictEqual(modified.localModified, true);
		assert.strictEqual(modified.trusted, false);
		assert.strictEqual(modified.enabled, true);

		await service.setEnabled(URI.file(configurationRepository), modified.manifest.id, false);
		assert.strictEqual(
			await fs.stat(join(modified.resource.fsPath, 'skills', 'review', 'SKILL.md'))
				.then(stat => stat.isFile()),
			true
		);
		await service.uninstall(URI.file(configurationRepository), modified.manifest.id);
		assert.strictEqual(
			await fs.stat(modified.resource.fsPath).then(() => true, () => false),
			false
		);
	});

	test('rejects unsafe packages and content changed after preview', async () => {
		await writePlugin({ version: '1.0.0', readme: 'version one\n' });
		const sourceRequest = { type: 'local' as const, location: URI.file(source) };
		const preview = await service.preview(sourceRequest);
		await fs.writeFile(join(source, 'README.md'), 'changed after preview\n');
		await assert.rejects(
			() => service.install(
				URI.file(configurationRepository),
				sourceRequest,
				preview.contentHash,
				false
			),
			/content changed after preview/
		);

		await fs.symlink('/tmp', join(source, 'unsafe-link'));
		await assert.rejects(
			() => service.preview(sourceRequest),
			/cannot contain symbolic links/
		);
	});

	test('records requested and resolved Git revisions without embedded credentials', async () => {
		await writePlugin({ version: '1.0.0', readme: 'version one\n' });
		await execFileAsync('git', ['init', '-b', 'main'], { cwd: source });
		await execFileAsync('git', ['config', 'user.email', 'plugin@example.com'], { cwd: source });
		await execFileAsync('git', ['config', 'user.name', 'Plugin Fixture'], { cwd: source });
		await execFileAsync('git', ['add', '.'], { cwd: source });
		await execFileAsync('git', ['commit', '-m', 'Initial plugin'], { cwd: source });

		const preview = await service.preview({
			type: 'git',
			url: source,
			revision: 'main',
		});
		assert.strictEqual(preview.source.type, 'git');
		if (preview.source.type === 'git') {
			assert.strictEqual(preview.source.requestedRevision, 'main');
			assert.match(preview.source.revision, /^[a-f0-9]{40}$/);
		}
		const installed = await service.install(
			URI.file(configurationRepository),
			{ type: 'git', url: source, revision: 'main' },
			preview.contentHash,
			false
			);
			assert.strictEqual(installed.source.type, 'git');
			if (installed.source.type === 'git') {
				assert.strictEqual(installed.source.locationType, 'local');
			}
			assert.doesNotMatch(
				await fs.readFile(join(installed.resource.fsPath, PLUGIN_INSTALL_RECORD_FILE), 'utf8'),
				new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
			);

			await fs.writeFile(join(source, 'README.md'), 'version two\n');
		const manifest = JSON.parse(await fs.readFile(join(source, PLUGIN_MANIFEST_FILE), 'utf8'));
		manifest.version = '2.0.0';
		await fs.writeFile(join(source, PLUGIN_MANIFEST_FILE), `${JSON.stringify(manifest, null, '\t')}\n`);
		await execFileAsync('git', ['add', '.'], { cwd: source });
		await execFileAsync('git', ['commit', '-m', 'Update plugin'], { cwd: source });
		const updates = await service.checkUpdates(URI.file(configurationRepository));
		assert.strictEqual(updates[0].preview.manifest.version, '2.0.0');
		assert.notStrictEqual(updates[0].preview.source.type === 'git'
			? updates[0].preview.source.revision
			: undefined,
		preview.source.type === 'git' ? preview.source.revision : undefined);

		const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim();
		await execFileAsync(
			'git',
			['update-index', '--add', '--cacheinfo', `160000,${head},vendor`],
			{ cwd: source }
		);
		await execFileAsync('git', ['commit', '-m', 'Add unsupported submodule entry'], { cwd: source });
		await assert.rejects(
			() => service.preview({ type: 'git', url: source, revision: 'main' }),
			/containing submodules are not supported/
		);

		await assert.rejects(
			() => service.preview({
				type: 'git',
				url: 'https://user:secret@example.com/plugin.git',
				revision: 'main',
			}),
			/must not contain embedded credentials/
		);
	});

	test('detects updates without mutation and supports merge, fork, and apply', async () => {
		await writePlugin({ version: '1.0.0', readme: 'version one\n' });
		const sourceRequest = { type: 'local' as const, location: URI.file(source) };
		const firstPreview = await service.preview(sourceRequest);
		let installed = await service.install(
			URI.file(configurationRepository),
			sourceRequest,
			firstPreview.contentHash,
			false
		);

		await writePlugin({ version: '2.0.0', readme: 'version two\n' });
		let updates = await service.checkUpdates(URI.file(configurationRepository));
		assert.strictEqual(updates.length, 1);
		assert.strictEqual(updates[0].preview.manifest.version, '2.0.0');
		assert.strictEqual(
			await fs.readFile(join(installed.resource.fsPath, 'README.md'), 'utf8'),
			'version one\n'
		);

		await fs.writeFile(join(installed.resource.fsPath, 'LOCAL.md'), 'user local change\n');
		const merged = await service.applyUpdate(
			URI.file(configurationRepository),
			installed.manifest.id,
			'merge',
			updates[0].preview.contentHash,
			false
		);
		assert.strictEqual(merged.conflicts, undefined);
		assert.strictEqual(merged.installed.manifest.version, '2.0.0');
		assert.strictEqual(merged.installed.localModified, true);
		assert.strictEqual(
			await fs.readFile(join(merged.installed.resource.fsPath, 'LOCAL.md'), 'utf8'),
			'user local change\n'
		);
		assert.strictEqual(
			await fs.readFile(join(merged.installed.resource.fsPath, 'README.md'), 'utf8'),
			'version two\n'
		);

		await writePlugin({
			version: '3.0.0',
			readme: 'version three\n',
			localFile: 'upstream local change\n',
		});
		updates = await service.checkUpdates(URI.file(configurationRepository));
		const conflicted = await service.applyUpdate(
			URI.file(configurationRepository),
			installed.manifest.id,
			'merge',
			updates[0].preview.contentHash,
			false
		);
		assert.deepStrictEqual(conflicted.conflicts, ['LOCAL.md']);
		assert.strictEqual(conflicted.installed.manifest.version, '2.0.0');

		const forked = await service.applyUpdate(
			URI.file(configurationRepository),
			installed.manifest.id,
			'fork',
			updates[0].preview.contentHash,
			false
		);
		assert.match(forked.forkedPluginId ?? '', /^review-tools-fork-[a-f0-9]{8}$/);
		const afterFork = await service.list(URI.file(configurationRepository));
		assert.strictEqual(afterFork.length, 2);
		assert.strictEqual(
			afterFork.find(plugin => plugin.manifest.id === 'review-tools')?.manifest.version,
			'2.0.0'
		);
		assert.strictEqual(
			afterFork.find(plugin => plugin.manifest.id === forked.forkedPluginId)?.enabled,
			false
		);

		const applied = await service.applyUpdate(
			URI.file(configurationRepository),
			installed.manifest.id,
			'apply',
			updates[0].preview.contentHash,
			false
		);
		installed = applied.installed;
		assert.strictEqual(installed.manifest.version, '3.0.0');
		assert.strictEqual(installed.localModified, false);
		assert.strictEqual(
			await fs.readFile(join(installed.resource.fsPath, 'LOCAL.md'), 'utf8'),
			'upstream local change\n'
		);
	});
});
